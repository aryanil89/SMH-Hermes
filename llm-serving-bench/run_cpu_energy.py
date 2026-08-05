#!/usr/bin/env python
"""CPU-mode Joules/query: start a CPU server on 18191, warm it, run the
energy.py protocol (3 queries -- CPU is ~7 min/query at the 12.5K shape),
kill the server. CPU mode never attaches to the Hexagon DSP, so this is
safe to run alongside the production NPU server."""

import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import bench    # noqa: E402  (start_server/wait_healthy/kill_server/post_chat)
import energy   # noqa: E402

# Two 64K servers (2 x ~11.5 GB commit) exceed this 32 GB machine's commit
# limit -- the first attempt died OOM mid-query. The energy queries are 12.5K
# tokens, so 16K context is ample and cuts KV prealloc 9.2 -> 2.3 GB.
# J/query is unaffected: same model, same computation for the same prompt.
bench.NCTX = "16384"

CSV = Path(r"C:\Users\qc_de\Desktop\hwinfo-log.csv")

proc = bench.start_server("cpu", HERE / "serve-cpu-energy.log")
if not bench.wait_healthy():
    bench.kill_server(proc)
    sys.exit("CPU server never became healthy")
try:
    t, _ = bench.post_chat({"model": bench.Q4_0,
                            "messages": [{"role": "user", "content": "Say OK."}],
                            "max_tokens": 4})
    print(f"warm-up (model load): {t:.1f}s", flush=True)
    # 3.9K-token queries (the shape that survived a 13-min CPU bench run in
    # this environment) instead of 12.7K ones (killed twice mid-query). The
    # J/query for the 12.7K shape is then scaled by prompt tokens -- slightly
    # conservative for CPU (attention superlinearity), which only understates
    # our NPU advantage.
    energy.run_protocol("http://127.0.0.1:18191/v1", "cpu-3.9K", "System",
                        queries=6, idle_s=60.0, csv_path=CSV, prompt_reps=120)
finally:
    bench.kill_server(proc)
    print("CPU server stopped, port 18191 released.", flush=True)
