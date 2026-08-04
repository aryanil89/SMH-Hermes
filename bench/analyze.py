"""Turn qnn-profile-viewer CSVs into the BENCHMARK_PLAN tables.

Reports prefill (prompt_ar128) and decode (token_ar1) separately, mean +/- std
over N inferences with the first (cold) inference reported separately and not
averaged in, per the llama-bench convention fixed in BENCHMARK_PLAN.md section 1.
"""
import csv
import json
import os
import re
import statistics as st

WORK = os.path.dirname(os.path.abspath(__file__))
GRAPH_ROW = re.compile(r"^Graph \d+: (.+)$")
OP_ROW = re.compile(r"^(.*):OpId_(\d+) \(cycles\)$")


def load(csv_path):
    rows = []
    with open(csv_path, newline="", encoding="utf-8", errors="replace") as fh:
        for r in csv.reader(fh):
            if len(r) >= 7:
                rows.append([c.strip() for c in r])
    return rows


def series(rows, stage, ident):
    return [float(r[2]) for r in rows
            if r[1] == stage and r[6] == ident and r[2].lstrip("-").isdigit()]


def stats(v):
    if not v:
        return None
    warm = v[1:] if len(v) > 1 else v
    return {
        "n": len(v), "cold_us": v[0],
        "mean_us": st.mean(warm), "std_us": st.pstdev(warm) if len(warm) > 1 else 0.0,
        "p50_us": st.median(warm), "min_us": min(warm), "max_us": max(warm),
    }


def analyze(res):
    if not res.get("csv") or not os.path.isfile(res["csv"]):
        return None
    rows = load(res["csv"])

    graph_ident = next((r[6] for r in rows
                        if r[1] == "EXECUTE" and GRAPH_ROW.match(r[6] or "")
                        and GRAPH_ROW.match(r[6]).group(1) == res["graph"]), None)
    lat = stats(series(rows, "EXECUTE", graph_ident)) if graph_ident else None
    cyc = stats(series(rows, "EXECUTE", "Accelerator (execute) time (cycles)"))
    acc = stats(series(rows, "EXECUTE", "Accelerator (execute) time"))
    init = max(series(rows, "INIT", "null") or [0])

    ops = {}
    for r in rows:
        if r[1] != "EXECUTE":
            continue
        m = OP_ROW.match(r[6] or "")
        if m and r[2].lstrip("-").isdigit():
            ops.setdefault(m.group(1), []).append(float(r[2]))
    op_means = sorted(((k, st.mean(v), len(v)) for k, v in ops.items()),
                      key=lambda x: -x[1])

    backend = next((r[2] for r in rows if r[0] == "Backend version"), None)
    hvx = series(rows, "EXECUTE", "Number of HVX threads used")
    vtcm = stats(series(rows, "EXECUTE", "Time for initial VTCM acquire"))

    return {
        "graph": res["graph"], "part": res["part"], "slot": res["slot"],
        "iterations": res["iterations"], "latency": lat, "cycles": cyc,
        "accel_us": acc, "init_us": init, "n_ops": len(ops),
        "top_ops": op_means[:8], "op_total_cycles": sum(m for _, m, _ in op_means),
        "hvx_threads": hvx[0] if hvx else None,
        "vtcm_us": vtcm["mean_us"] if vtcm else None,
        "backend": backend,
    }


def fmt(x, nd=0):
    return f"{x:,.{nd}f}" if isinstance(x, (int, float)) else "-"


def main():
    import sys
    src = sys.argv[1] if len(sys.argv) > 1 else "results.json"
    tag = sys.argv[2] if len(sys.argv) > 2 else ""
    with open(os.path.join(WORK, src), encoding="utf-8") as fh:
        results = json.load(fh)

    an = [a for a in (analyze(r) for r in results) if a]
    phases = {"prompt_ar128": "PREFILL (128-token chunk)", "token_ar1": "DECODE (1 token)"}

    out = []
    for key, title in phases.items():
        rows = [a for a in an if a["graph"].startswith(key)]
        if not rows:
            continue
        out.append(f"\n## {title}\n")
        out.append("| part | graph slot | ops | latency mean±std (ms) | p50 | cold | "
                   "HTP cycles (mean) | VTCM acq (µs) |")
        out.append("|---|---|---|---|---|---|---|---|")
        tot_mean = tot_var = tot_cyc = 0.0
        for a in sorted(rows, key=lambda z: z["part"]):
            l, c = a["latency"], a["cycles"]
            if not l:
                continue
            tot_mean += l["mean_us"]
            tot_var += l["std_us"] ** 2
            tot_cyc += c["mean_us"] if c else 0
            out.append(
                f"| {a['part'].replace('_of_4.bin','')} | {a['slot']} | {a['n_ops']} | "
                f"{l['mean_us']/1000:.2f} ± {l['std_us']/1000:.2f} | "
                f"{l['p50_us']/1000:.2f} | {l['cold_us']/1000:.2f} | "
                f"{fmt(c['mean_us'] if c else None)} | {fmt(a['vtcm_us'])} |")
        tok = 128 if key == "prompt_ar128" else 1
        out.append(f"| **whole model (4 parts)** | | | **{tot_mean/1000:.2f} ± "
                   f"{tot_var ** 0.5/1000:.2f}** | | | **{fmt(tot_cyc)}** | |")
        out.append(f"\n**{tok} token(s) per pass → "
                   f"{tok * 1e6 / tot_mean:,.1f} tok/s** (sum of graph execute times only; "
                   f"excludes Genie orchestration, KV-cache copies between parts, sampling)\n")

        out.append("Per-op hot spots (mean HTP cycles/inference):\n")
        for a in sorted(rows, key=lambda z: z["part"]):
            tops = ", ".join(f"`{n}` {fmt(m)}" for n, m, _ in a["top_ops"][:4])
            out.append(f"- {a['part'].replace('_of_4.bin','')} ({a['n_ops']} ops, "
                       f"Σ{fmt(a['op_total_cycles'])} cyc): {tops}")

    init_tot = sum(a["init_us"] for a in an if a["graph"].startswith("prompt"))
    out.append(f"\n## Init\n\nContext load (all 4 parts, cold): "
               f"**{init_tot/1e6:.2f} s**   ·   HVX threads: "
               f"{an[0]['hvx_threads']}   ·   backend {an[0]['backend']}\n")

    text = "\n".join(out)
    print(text)
    with open(os.path.join(WORK, f"BENCH_TABLES{tag}.md"), "w", encoding="utf-8") as fh:
        fh.write(text)
    with open(os.path.join(WORK, f"analysis{tag}.json"), "w", encoding="utf-8") as fh:
        json.dump(an, fh, indent=1, default=str)


if __name__ == "__main__":
    main()
