#!/usr/bin/env python
"""
Direct long-context prefill timing against a running GenieX server.

Two probes, non-stream, max_tokens=8, nonce-prefixed (no prefix-cache credit):
  1. 12,670-token prompt  — the measured Hermes request shape (state.db mean);
     validates the modeled ~42s agent iteration with a direct measurement.
  2. ~60K-token prompt    — near the 65,536 nctx ceiling; the capability number
     for a full-context session, and the empirical basis for the session token
     budget + the providers.custom.stale_timeout_seconds: 900 setting.

Usage: python prefill_long.py [--base http://127.0.0.1:18181/v1]
Appends to prefill-long-results.json; never overwrites.
"""

import argparse
import json
import time
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).parent
MODEL = "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0"
PARA = (
    "Datacenter thermal management requires continuous monitoring of inlet and "
    "outlet temperatures across every rack, correlation of airflow metrics with "
    "server load, and rapid escalation when thresholds are crossed. "
)  # ~32.2 tokens per repetition (measured via bench.py usage counts)


def probe(base: str, reps: int, label: str) -> dict:
    nonce = f"[longctx {uuid.uuid4().hex[:12]}] "
    prompt = nonce + PARA * reps + "\nReply with the single word: DONE"
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 8,
    }).encode()
    req = urllib.request.Request(f"{base}/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    print(f"[{label}] sending ~{int(reps * 32.2):,}-token prompt ...", flush=True)
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=900) as resp:
        data = json.loads(resp.read())
    dt = time.monotonic() - t0
    ptok = data["usage"]["prompt_tokens"]
    out = {
        "label": label,
        "prompt_tokens": ptok,
        "seconds": round(dt, 1),
        "prefill_tok_s": round(ptok / dt),
        "finish_reason": data["choices"][0]["finish_reason"],
    }
    print(f"[{label}] {ptok:,} tok in {dt:.1f}s = {ptok/dt:.0f} tok/s "
          f"(finish: {out['finish_reason']})", flush=True)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:18181/v1")
    ap.add_argument("--reps", type=int,
                    help="single probe with PARA*reps (~32.2 tok/rep) instead "
                         "of the default 12.7K+60K sequence")
    ap.add_argument("--label", default="custom")
    args = ap.parse_args()

    results = []
    if args.reps:
        results.append(probe(args.base, args.reps, args.label))
    else:
        # 12,670-token Hermes shape: (12670 - overhead) / 32.2 ≈ 391
        results.append(probe(args.base, 391, "agent-shape-12.7K"))
        # ~60K: high enough to be the ceiling number, margin under 65,536
        results.append(probe(args.base, 1860, "near-ceiling-60K"))

    out_path = HERE / "prefill-long-results.json"
    prior = json.loads(out_path.read_text()) if out_path.exists() else []
    prior.append({"base": args.base, "runs": results})
    out_path.write_text(json.dumps(prior, indent=2), encoding="utf-8")
    print(f"Appended to {out_path}")


if __name__ == "__main__":
    main()
