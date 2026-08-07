#!/usr/bin/env python
"""
Standalone GenieX serving-mode benchmark for Snapdragon X Elite.

Project-independent: measures every (compute-mode x model) config against the
axes the hackathon rubric scores (latency/performance, resource utilization,
energy-efficiency proxy) and declares a winner under the hard constraint that
OpenAI tool-calling must work (an agent is useless without it).

Per config it reports:
  - model load time (cold first request)
  - prefill tok/s     (fixed ~3.4K-token prompt, r reps, mean +/- std)
  - decode tok/s      (~400-token generation, r reps, mean +/- std)
  - tool-call PASS/FAIL (finish_reason == "tool_calls")
  - CPU %             (sampled during the decode runs -- efficiency proxy:
                       low CPU + normal speed means the accelerator did the work)
  - server RSS (GB)

Usage:
  python bench.py                     # Q4_0 x {npu, hybrid, gpu}, 5 reps
  python bench.py --modes cpu         # the missing BENCHMARK_PLAN §1 column
  python bench.py --reps 3            # fewer repetitions
  python bench.py --model unsloth/Qwen3.5-4B-GGUF:Q4_0   # candidate-model gate
  python bench.py --full              # + Q4_K_M x npu (silent CPU-fallback trap)

Method notes:
  - every prefill request carries a unique nonce PREFIX so GenieX's partial
    prefix cache (~18%) cannot flatter the number; runs are mean +/- std over
    --reps repetitions per BENCHMARK_PLAN §1 (r >= 5), never best-of-N
  - prefill uses max_tokens=1 so only one decoded token sits in the wall-time
    denominator (true TTFT would need streaming, which GenieX tool-calling
    currently can't use)
  - the modeled agent iteration uses the measured Hermes request shape from
    state.db -- 12,670 prompt + 105 completion tokens -- not a guessed 8K/150

Results: RESULTS.md / results.json. Pre-existing copies are moved into
archive/ first, never overwritten (RESULTS.md has been hand-merged before).
"""

import argparse
import csv
import io
import json
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

GENIEX = r"C:\Users\qc_de\AppData\Local\GenieX CLI\geniex.exe"
# Dedicated benchmark port: never touches the production server on 18181.
PORT = 18191
BASE = f"http://127.0.0.1:{PORT}/v1"
NCTX = "65536"
HERE = Path(__file__).parent
Q4_0 = "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0"
Q4KM = "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M"

# Measured Hermes request shape (mean over 23 API calls in state.db,
# 2026-08-05): 12,670 prompt tokens, 105 completion tokens. The app is ~82%
# prefill-bound at the winning config; do not "round" these back to 8K/150.
AGENT_PREFILL_TOK = 12_670
AGENT_DECODE_TOK = 105

PREFILL_PARA = (
    "Datacenter thermal management requires continuous monitoring of inlet and "
    "outlet temperatures across every rack, correlation of airflow metrics with "
    "server load, and rapid escalation when thresholds are crossed. " * 120
)
TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_environmental_reading",
        "description": "Get temperature/humidity/leak status for a rack",
        "parameters": {
            "type": "object",
            "properties": {"rack_id": {"type": "string"}},
            "required": ["rack_id"],
        },
    },
}]


def post_chat(payload: dict, timeout: int = 600) -> tuple[float, dict]:
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        f"{BASE}/chat/completions", data=body,
        headers={"Content-Type": "application/json"},
    )
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    return time.monotonic() - t0, data


def port_free() -> bool:
    import socket
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", PORT))
            return True
        except OSError:
            return False


def kill_server(proc: subprocess.Popen | None) -> None:
    """Kill only OUR child server, then wait for the OS to release the port."""
    if proc is not None and proc.poll() is None:
        proc.kill()
        proc.wait(timeout=15)
    deadline = time.monotonic() + 30
    while not port_free() and time.monotonic() < deadline:
        time.sleep(1)


def start_server(compute: str, log_path: Path) -> subprocess.Popen:
    log = open(log_path, "w")
    return subprocess.Popen(
        [GENIEX, "serve", "--host", f"127.0.0.1:{PORT}",
         "--nctx", NCTX, "--compute", compute, "--skip-update"],
        stdout=log, stderr=subprocess.STDOUT,
    )


def wait_healthy(timeout_s: int = 90) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{BASE}/models", timeout=3):
                return True
        except (urllib.error.URLError, OSError):
            time.sleep(2)
    return False


def sample_cpu(samples: list, count: int = 8) -> None:
    """typeperf CSV: one header line, then '"time","value"' rows."""
    proc = subprocess.run(
        ["typeperf", r"\Processor(_Total)\% Processor Time", "-sc", str(count), "-si", "1"],
        capture_output=True, text=True, check=False,
    )
    for row in csv.reader(io.StringIO(proc.stdout)):
        if len(row) >= 2:
            try:
                samples.append(float(row[1]))
            except ValueError:
                continue


def server_rss_gb() -> float | None:
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "(Get-Process geniex -ErrorAction SilentlyContinue | "
         "Measure-Object WorkingSet64 -Sum).Sum"],
        capture_output=True, text=True, check=False,
    )
    try:
        return round(int(proc.stdout.strip()) / 1024**3, 2)
    except ValueError:
        return None


def mean_std(values: list[float]) -> tuple[float, float | None]:
    return (statistics.mean(values),
            statistics.stdev(values) if len(values) >= 2 else None)


def bench_config(compute: str, model: str, reps: int) -> dict:
    label = f"{model.split(':')[-1]}-{compute}"
    print(f"\n=== {label} (reps={reps}) ===", flush=True)
    result = {"config": label, "compute": compute, "model": model, "reps": reps}
    kill_server(None)
    proc = start_server(compute, HERE / f"serve-{label}.log")
    if not wait_healthy():
        result["error"] = "server never became healthy"
        kill_server(proc)
        return result

    try:
        # Cold call = model load + tiny inference. Single-shot by nature:
        # repeating it would need a server restart per rep.
        t, _ = post_chat({"model": model,
                          "messages": [{"role": "user", "content": "Say OK."}],
                          "max_tokens": 4})
        result["load_s"] = round(t, 1)
        print(f"  load+first: {t:.1f}s", flush=True)

        # Prefill: r reps, each with a unique nonce PREFIX so the prefix cache
        # can never match from position 0. max_tokens=1 keeps decode out of
        # the denominator (bar one token).
        prefill_rates = []
        ptok = None
        for i in range(reps):
            nonce = f"[bench run {uuid.uuid4().hex[:12]}] "
            t, d = post_chat({"model": model,
                              "messages": [{"role": "user",
                                            "content": nonce + PREFILL_PARA + "\nReply: DONE"}],
                              "max_tokens": 1})
            ptok = d["usage"]["prompt_tokens"]
            prefill_rates.append(ptok / t)
            print(f"  prefill[{i+1}/{reps}]: {ptok} tok in {t:.1f}s = {ptok/t:.0f} tok/s", flush=True)
        p_mean, p_std = mean_std(prefill_rates)
        result["prefill_tokens"] = ptok
        result["prefill_tok_s"] = round(p_mean)
        result["prefill_tok_s_std"] = round(p_std, 1) if p_std is not None else None
        result["prefill_tok_s_runs"] = [round(r, 1) for r in prefill_rates]

        # Decode: r reps with CPU sampling pooled across all of them.
        cpu_samples: list[float] = []
        decode_rates = []
        ctok = None
        for i in range(reps):
            sampler = threading.Thread(target=sample_cpu, args=(cpu_samples,))
            sampler.start()
            t, d = post_chat({"model": model,
                              "messages": [{"role": "user",
                                            "content": f"[bench run {uuid.uuid4().hex[:12]}] "
                                                       "Write a 300-word essay about datacenter cooling."}],
                              "max_tokens": 400})
            sampler.join(timeout=15)
            ctok = d["usage"]["completion_tokens"]
            decode_rates.append(ctok / t)
            print(f"  decode[{i+1}/{reps}]: {ctok} tok in {t:.1f}s = {ctok/t:.1f} tok/s", flush=True)
        d_mean, d_std = mean_std(decode_rates)
        result["decode_tokens"] = ctok
        result["decode_tok_s"] = round(d_mean, 1)
        result["decode_tok_s_std"] = round(d_std, 2) if d_std is not None else None
        result["decode_tok_s_runs"] = [round(r, 2) for r in decode_rates]
        result["cpu_pct_during_decode"] = round(sum(cpu_samples) / len(cpu_samples)) if cpu_samples else None
        result["rss_gb"] = server_rss_gb()
        print(f"  decode mean: {d_mean:.1f} tok/s | CPU {result['cpu_pct_during_decode']}%", flush=True)

        # Tool-calling gate (retry once -- distinguish flake from structural failure).
        for attempt in (1, 2):
            try:
                t, d = post_chat({"model": model,
                                  "messages": [{"role": "user",
                                                "content": "What is the temperature in rack B1?"}],
                                  "tools": TOOLS, "max_tokens": 128}, timeout=300)
                if "choices" not in d:
                    # GenieX GPU bug returns 200 with an error object instead.
                    result["tool_call"] = f"FAIL ({d.get('error', 'no choices in response')})"
                    continue
                finish = d["choices"][0]["finish_reason"]
                result["tool_call"] = "PASS" if finish == "tool_calls" else f"FAIL ({finish})"
                break
            except urllib.error.HTTPError as e:
                body = e.read().decode(errors="replace")[:120]
                result["tool_call"] = f"FAIL (HTTP {e.code}: {body})"
            except Exception as e:
                result["tool_call"] = f"FAIL ({e})"
        print(f"  tool-call: {result['tool_call']}", flush=True)
    except Exception as e:
        result["error"] = str(e)[:200]
        print(f"  ERROR: {result['error']}", flush=True)
    finally:
        kill_server(proc)
    return result


def archive_existing_outputs() -> None:
    """Never clobber prior results -- RESULTS.md has been hand-merged before."""
    stamp = time.strftime("%Y%m%d-%H%M%S")
    arch = HERE / "archive"
    for name in ("RESULTS.md", "results.json"):
        p = HERE / name
        if p.exists():
            arch.mkdir(exist_ok=True)
            dest = arch / f"{p.stem}-{stamp}{p.suffix}"
            p.rename(dest)
            print(f"Archived {name} -> archive/{dest.name}")


def fmt_pm(mean, std) -> str:
    if mean is None:
        return "—"
    return f"{mean} ± {std}" if std is not None else str(mean)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true",
                    help="also run Q4_K_M on npu (CPU-fallback demonstration)")
    ap.add_argument("--modes", default="npu,hybrid,gpu",
                    help="comma-separated compute modes to run (default: npu,hybrid,gpu; "
                         "cpu is also valid and is the missing BENCHMARK_PLAN §1 column)")
    ap.add_argument("--reps", type=int, default=5,
                    help="repetitions per prefill/decode measurement (default 5, per §1 r>=5)")
    ap.add_argument("--model", default=Q4_0,
                    help="model to benchmark (default Q4_0; use for candidate-model gating, "
                         "e.g. unsloth/Qwen3.5-4B-GGUF:Q4_0 -- only Q4_0/Q8_0 offload to Hexagon)")
    args = ap.parse_args()

    configs = [(m.strip(), args.model) for m in args.modes.split(",") if m.strip()]
    if args.full:
        configs.append(("npu", Q4KM))

    results = [bench_config(c, m, args.reps) for c, m in configs]

    # Winner: fastest end-to-end among tool-call passers. Score = time to
    # finish the MEASURED Hermes agent iteration (12,670-tok prefill +
    # 105-tok decode, state.db means -- the app is ~82% prefill-bound).
    def agent_iter_s(r: dict) -> float:
        if r.get("tool_call") != "PASS":
            return float("inf")
        try:
            return (AGENT_PREFILL_TOK / r["prefill_tok_s"]
                    + AGENT_DECODE_TOK / r["decode_tok_s"])
        except (KeyError, TypeError, ZeroDivisionError):
            return float("inf")

    eligible = [r for r in results if r.get("tool_call") == "PASS"]
    winner = min(eligible, key=agent_iter_s) if eligible else None

    lines = [
        "# GenieX serving benchmark — results",
        "",
        f"Machine: Snapdragon X Elite (Hexagon v73 / Adreno X1-85 / 12x Oryon), nctx={NCTX}.",
        f"Reps: {args.reps} per measurement, mean ± std; prefill nonce-prefixed so the",
        "prefix cache cannot flatter it.",
        f"Winner rule: fastest modeled agent iteration ({AGENT_PREFILL_TOK:,}-tok prefill "
        f"+ {AGENT_DECODE_TOK}-tok decode — the measured Hermes request shape from state.db)",
        "**among configs where OpenAI tool-calling passes** — an agent can't use a",
        "config that can't call tools, however fast it is.",
        "",
        "| config | load s | prefill tok/s | decode tok/s | CPU% @decode | RSS GB | tool-call | modeled agent-iter |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        it = agent_iter_s(r)
        lines.append(
            f"| {r['config']} | {r.get('load_s','—')} | "
            f"{fmt_pm(r.get('prefill_tok_s'), r.get('prefill_tok_s_std'))} | "
            f"{fmt_pm(r.get('decode_tok_s'), r.get('decode_tok_s_std'))} | "
            f"{r.get('cpu_pct_during_decode','—')} | "
            f"{r.get('rss_gb','—')} | {r.get('tool_call', r.get('error','—'))} | "
            f"{'—' if it == float('inf') else str(round(it)) + 's'} |"
        )
    lines += ["", f"**Winner: {winner['config']}**" if winner
              else "**No config passed the tool-call gate.**"]

    report = "\n".join(lines)
    print("\n" + report)
    archive_existing_outputs()
    (HERE / "RESULTS.md").write_text(report, encoding="utf-8")
    (HERE / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"\nWritten: {HERE / 'RESULTS.md'}, {HERE / 'results.json'}")
    print("\nNote: this benchmark ran on port {0} and never touched the production"
          "\nserver on 18181. To (re)start production:".format(PORT))
    print('  Start-Process "$env:LOCALAPPDATA\\GenieX CLI\\geniex.exe" '
          '-ArgumentList "serve","--nctx","65536","--compute","npu" -WindowStyle Hidden')


if __name__ == "__main__":
    main()
