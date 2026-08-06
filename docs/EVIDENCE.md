# Benchmark evidence — one index for every measured claim

Everything the Technical Implementation rubric asks about (resource utilization,
optimization, latency/performance, energy efficiency), with a pointer to the measurement
behind each number. Nothing here is modeled unless labeled as such; the winner table
disqualifies configs that cannot tool-call, regardless of speed.

## Headline numbers, each with its source

| Claim | Number | Measured | Source |
|---|---|---|---|
| NPU vs CPU prefill throughput | **382 ± 8.3 tok/s vs 35 ± 7.2** (~11×) | 2026-08-05, 5 reps, nonce-prefixed | [llm-serving-bench/RESULTS.md](../llm-serving-bench/RESULTS.md) main table |
| Real agent turn at the production request shape (12.5K tokens) | **~68 s** on NPU (direct-measured; the modeled 41 s is labeled optimistic) vs **~371 s** modeled on CPU | 2026-08-05 | RESULTS.md § Long-context prefill curve |
| Energy per query | NPU **471 J** (n=5) vs CPU 1,278 J at a *smaller* shape; **~8.7× more CPU energy per prompt-token** (0.327 vs 0.0375 J) | 2026-08-05, HWiNFO system rail, trapezoidal integration, idle-subtracted | RESULTS.md § Energy |
| System power lift under inference | NPU **+6.3 W** over idle vs CPU **+21.3 W** — and CPU still takes ~7× longer | 2026-08-05 | RESULTS.md § Energy |
| CPU load during NPU decode | **12.1% mean across 12 cores** vs 56–74% on CPU fallback | 2026-08-03 | [NPU_SPIKE_RESULTS.md](NPU_SPIKE_RESULTS.md) |
| Per-op NPU execution | All 8 graphs of the W4A16 bundle profiled on Hexagon, rc=0 | 2026-08-03 | [BENCHMARKS.md](BENCHMARKS.md), harness in `bench/` |
| Prompt-composition optimization | 78% of a request is fixed overhead; cutting the skills catalogue saved a measured **1,535 tok/call** (~7.5–10 s per call) | 2026-08-05 | RESULTS.md § Prompt composition |
| Sensor-edge-to-phone latency | ~15–30 s via the 15 s watchdog loop, from a measured 102 s worst case on the cron path | 2026-08-05 | [WATCHDOG.md](WATCHDOG.md) |
| Energy methodology precedent | arXiv 2606.11257 reports 315 vs 1,251 J/query (4.0×) on this SoC with a decode-heavier mix | — | cited in RESULTS.md § Energy |

Raw artifacts: `llm-serving-bench/energy-results.json`, `llm-serving-bench/cache-probe-results.json`,
`bench/` harness output. Reproduction commands are at the end of each RESULTS.md section.

## Screenshots — to capture (owner: team, before Friday demo)

None captured yet. Place them in `docs/evidence/` with the names below and link them from
the table above. Capture all three during **one** NPU query
(`hermes -z "assess the current incident"` — gives 60+ s of sustained load, enough time to
frame each window):

1. `docs/evidence/task-manager-npu.png` — Task Manager → Performance → **NPU** pane showing
   utilization during prefill, with the CPU pane visible (low) in the same frame. This is
   the one-glance "it really is the NPU" shot.
2. `docs/evidence/hwinfo-power.png` — HWiNFO sensor window on the **System [W]** rail
   during the same query: idle ~11.7 W → load ~18 W. This is the +6.3 W story in one image.
   (For contrast, an optional second shot during a CPU-server query showing ~32 W.)
3. `docs/evidence/qairt-visualizer.png` — QAIRT Visualizer per-op view of the profiled
   W4A16 bundle (see [BENCHMARK_PLAN.md](BENCHMARK_PLAN.md) / `bench/` for the profile
   artifacts it opens).

Use **PNG, under `docs/`** — `.gitignore` blocks all image formats repo-wide
(face-capture safety) and re-allows only `docs/**/*.png` (`.gitignore:31-33`). A JPG, or a
PNG anywhere else, will silently fail to commit.
