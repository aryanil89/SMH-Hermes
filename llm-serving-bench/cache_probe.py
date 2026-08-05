#!/usr/bin/env python
"""
Prefix-cache probe against a running GenieX server.

Three probes at the 12.7K agent shape (non-stream, small max_tokens):
  A-cold          fresh nonce, first sight of the prompt (baseline prefill)
  B-exact-repeat  byte-identical request (detects exact/prefix KV reuse)
  C-appended-turn same conversation + assistant reply + new user message —
                  the real Hermes turn pattern: stable prefix, new suffix.

If B/C finish in seconds instead of ~60s, GenieX reuses KV across requests
and Hermes turns can skip re-prefilling the whole history.

Usage: python cache_probe.py [--base URL] [--reps 391] [--cache-prompt]
  --cache-prompt sends llama.cpp-style "cache_prompt": true in the body.
Appends to cache-probe-results.json; never overwrites.
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


def chat(base: str, messages: list, max_tokens: int, extra: dict | None):
    body = {"model": MODEL, "messages": messages, "max_tokens": max_tokens}
    if extra:
        body.update(extra)
    req = urllib.request.Request(f"{base}/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=900) as resp:
        data = json.loads(resp.read())
    return time.monotonic() - t0, data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:18181/v1")
    ap.add_argument("--reps", type=int, default=391)
    ap.add_argument("--cache-prompt", action="store_true",
                    help='send "cache_prompt": true (llama.cpp server param)')
    args = ap.parse_args()
    extra = {"cache_prompt": True} if args.cache_prompt else None

    nonce = f"[cacheprobe {uuid.uuid4().hex[:12]}] "
    prompt = nonce + PARA * args.reps + "\nSummarize the core risk in one sentence."
    convo = [{"role": "user", "content": prompt}]
    results = []

    def record(label: str, dt: float, data: dict) -> str:
        u = data.get("usage", {})
        ptok = u.get("prompt_tokens", 0)
        row = {"label": label, "seconds": round(dt, 1), "prompt_tokens": ptok,
               "prefill_tok_s": round(ptok / dt) if dt else None,
               "completion_tokens": u.get("completion_tokens")}
        print(f"[{label}] {ptok:,} tok in {dt:.1f}s = {row['prefill_tok_s']} tok/s",
              flush=True)
        results.append(row)
        return data["choices"][0]["message"]["content"]

    print(f"probing {args.base} at ~{int(args.reps * 32.2):,} prompt tokens "
          f"(cache_prompt={'on' if extra else 'off'})", flush=True)

    dt, data = chat(args.base, convo, 32, extra)
    reply = record("A-cold", dt, data)

    dt, data = chat(args.base, convo, 32, extra)
    record("B-exact-repeat", dt, data)

    convo_c = convo + [{"role": "assistant", "content": reply},
                       {"role": "user",
                        "content": "Good. Now give one concrete mitigation."}]
    dt, data = chat(args.base, convo_c, 32, extra)
    record("C-appended-turn", dt, data)

    out_path = HERE / "cache-probe-results.json"
    prior = json.loads(out_path.read_text()) if out_path.exists() else []
    prior.append({"base": args.base, "reps": args.reps,
                  "cache_prompt": bool(extra), "runs": results})
    out_path.write_text(json.dumps(prior, indent=2), encoding="utf-8")
    print(f"Appended to {out_path}")


if __name__ == "__main__":
    main()
