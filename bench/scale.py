"""Context-length scaling table: whole-model prefill/decode vs cl.

Merges the per-cl basic-profiling runs. Decode on this bundle is statically
shaped per context length -- the graph reads the whole cl-sized KV cache every
token -- so latency vs cl is the memory-bound curve BENCHMARK_PLAN section 1
predicts, and it explains why the 4K-shaped bundle decodes slower than the
dynamically-shaped GGUF path at short contexts.
"""
import csv
import glob
import json
import os
import re
import statistics as st

WORK = os.path.dirname(os.path.abspath(__file__))
GRAPH_ROW = re.compile(r"^Graph \d+: (.+)$")


def warm_mean_std(csv_path, graph):
    if not csv_path or not os.path.isfile(csv_path):
        return None
    vals = []
    with open(csv_path, newline="", encoding="utf-8", errors="replace") as fh:
        for r in csv.reader(fh):
            if len(r) >= 7 and r[1].strip() == "EXECUTE":
                m = GRAPH_ROW.match(r[6].strip())
                if m and m.group(1) == graph and r[2].strip().isdigit():
                    vals.append(float(r[2]))
    if not vals:
        return None
    warm = vals[1:] if len(vals) > 1 else vals
    return st.mean(warm), (st.pstdev(warm) if len(warm) > 1 else 0.0), len(vals)


def main():
    files = {}
    for p in glob.glob(os.path.join(WORK, "results_basic*.json")):
        m = re.search(r"results_basic_(\d+)\.json$", p)
        files[int(m.group(1)) if m else 4096] = p

    rows = {}
    for cl, path in sorted(files.items()):
        with open(path, encoding="utf-8") as fh:
            res = json.load(fh)
        acc = {}
        for r in res:
            if r.get("returncode") != 0:
                continue
            s = warm_mean_std(r.get("csv"), r["graph"])
            if not s:
                continue
            phase = "prefill" if r["graph"].startswith("prompt") else "decode"
            d = acc.setdefault(phase, {"mean": 0.0, "var": 0.0, "parts": 0})
            d["mean"] += s[0]
            d["var"] += s[1] ** 2
            d["parts"] += 1
        rows[cl] = acc

    out = ["## Whole-model latency vs context length (W4A16 bundle, HTP v73, burst)\n",
           "| context | prefill 128-tok chunk (ms) | prefill tok/s | "
           "decode 1 tok (ms) | decode tok/s | parts |",
           "|---|---|---|---|---|---|"]
    for cl, acc in sorted(rows.items()):
        pf, dc = acc.get("prefill"), acc.get("decode")
        if not pf or not dc:
            continue
        pf_ms, pf_sd = pf["mean"] / 1000, pf["var"] ** 0.5 / 1000
        dc_ms, dc_sd = dc["mean"] / 1000, dc["var"] ** 0.5 / 1000
        out.append(
            f"| {cl} | {pf_ms:.1f} ± {pf_sd:.1f} | {128 * 1000 / pf_ms:,.0f} | "
            f"{dc_ms:.1f} ± {dc_sd:.1f} | {1000 / dc_ms:.1f} | "
            f"{pf['parts']}/{dc['parts']} |")

    text = "\n".join(out)
    print(text)
    with open(os.path.join(WORK, "SCALING.md"), "w", encoding="utf-8") as fh:
        fh.write(text + "\n")


if __name__ == "__main__":
    main()
