# Benchmark evidence — one index for every measured claim

Everything the Technical Implementation rubric asks about (resource utilization,
optimization, latency/performance, energy efficiency), with a pointer to the measurement
behind each number. Nothing here is modeled unless labeled as such; the winner table
disqualifies configs that cannot tool-call, regardless of speed.

## Headline numbers, each with its source

| Claim | Number | Measured | Source |
|---|---|---|---|
| NPU vs CPU prefill throughput | **382 ± 8.3 tok/s vs 35 ± 7.2** (~11×) | 2026-08-05, 5 reps, nonce-prefixed | [llm-serving-bench/RESULTS.md](../llm-serving-bench/RESULTS.md) main table |
| Real agent iteration at the production request shape (12.5K tokens) | **~68 s** on NPU — 60.9 s measured prefill + ~7 s decode (the modeled 41 s is labeled optimistic) — vs **~371 s** modeled on CPU; a full tool-calling turn chains 2+ iterations (2–4 min) | 2026-08-05 | RESULTS.md § Long-context prefill curve |
| Energy per query | NPU **471 J** (n=5) vs CPU 1,278 J at a *smaller* shape; **~8.7× more CPU energy per prompt-token** (0.327 vs 0.0375 J) | 2026-08-05, HWiNFO system rail, trapezoidal integration, idle-subtracted | RESULTS.md § Energy |
| System power lift under inference | NPU **+6.3 W** over idle vs CPU **+21.3 W** — and CPU still takes ~7× longer | 2026-08-05 | RESULTS.md § Energy |
| CPU load during NPU decode | **12–17%** vs 33%+ on the benchmarked Q4_0 CPU run and 56–74% under the Q4_K_M silent fallback | 2026-08-03 | [NPU_SPIKE_RESULTS.md](NPU_SPIKE_RESULTS.md) |
| Per-op NPU execution (laptop) | All 8 graphs of the W4A16 bundle profiled on Hexagon, rc=0 | 2026-08-03 | [BENCHMARKS.md](BENCHMARKS.md), harness in `bench/` |
| Per-op NPU execution (phone) | `prompt_ar128_cl512_2_of_4` profiled op-by-op on the 8 Elite Hexagon, 20 inferences, `burst` — rendered in QAIRT Visualizer's Performance panel | 2026-08-07 | [evidence/qairt-visualizer.png](evidence/qairt-visualizer.png); harness [bench/phone_profile.py](../bench/phone_profile.py); see § *How shot 3 was produced* |
| Prompt-composition optimization | 78% of a request is fixed overhead; cutting the skills catalogue saved a measured **1,535 tok/call** (~7.5–10 s per call) | 2026-08-05 | RESULTS.md § Prompt composition |
| Sensor-edge-to-phone latency | ~15–30 s via the 15 s watchdog loop, from a measured 102 s worst case on the cron path | 2026-08-05 | [WATCHDOG.md](WATCHDOG.md) |
| Energy methodology precedent | arXiv 2606.11257 reports 315 vs 1,251 J/query (4.0×) on this SoC with a decode-heavier mix | — | cited in RESULTS.md § Energy |
| Phone (8 Elite) NPU — same model on the second Hexagon | **prefill 1,918.0 ± 16.9 tok/s, decode 23.1 ± 1.3** (w4a16, ctx 4096, 1,248-tok prompt, TTFT 0.65 s) | 2026-08-06, 5 reps + warmup, nonce-prefixed, `genie-t2t-run` over `adb` — config differs from the laptop row (quant/context/runner), not a 1:1 comparison | [llm-serving-bench/RESULTS.md](../llm-serving-bench/RESULTS.md#phone-benchmark-snapdragon-8-elite--2026-08-06) |
| Phone-NPU failover — dead GenieX → labeled degraded answer from the phone | **12.0 s** message→delivered answer (phone inference 9.3 s of it, ~2 s refused-probe detection) | 2026-08-06, live E2E (**n=1**): GenieX killed with its supervisor disabled, TCP-refuse detected, the installed hook fired with the real chat context, answer delivered to Telegram + the wall feed. The gateway-inbound seam itself is exercised via the identical mechanism the ack hook uses in production; a full Telegram-inbound rehearsal is the T-15 runbook step | [hermes-hooks/README.md](../hermes-hooks/README.md) § failover; arm/disarm: `scripts/demo-failover-ON/OFF.ps1` |
| Failover **phone leg**, repeated | **7.1 ± 0.7 s** (n=5, 5.9–7.6, 5/5 succeeded) — of which **model load 3.83 ± 0.04 s is paid per question**; prefill 1,100 ± 43 tok/s at ~134-token prompts, decode 25.8 ± 1.0 tok/s, TTFT 0.12 s | 2026-08-07, 5 different questions through the installed hook's own code path (`handler.py --try` — sends nothing, never touches GenieX). This is the phone leg of the row above, measured repeatedly; the end-to-end row stays **n=1** because measuring it requires killing GenieX. Answer length drives the variance: read it as ~4.0 s fixed + ~0.04 s per generated token, which is why an earlier single 9.3 s sample was a longer answer, not a slower phone. A prior identical run gave 7.3 ± 0.4 s | [RESULTS.md § failover round-trip](../llm-serving-bench/RESULTS.md#the-failover-round-trip-decomposed--n5-2026-08-07); driver `llm-serving-bench/phone/failover-reps.ps1`; raw `llm-serving-bench/phone/failover-reps/` |

Raw artifacts: `llm-serving-bench/energy-results.json`, `llm-serving-bench/prefill-long-results.json`,
`llm-serving-bench/cache-probe-results.json`,
`llm-serving-bench/phone/` (per-rep logs + `--profile` JSONs + `phone-results.json`),
`bench/` harness output. Reproduction commands are at the end of each RESULTS.md section.

## Screenshots

**Dashboard UI** (2026-08-06): seven screenshots covering every wall tab are in
[`evidence/wall/`](evidence/wall/). These are UI shots of the tabs described in README §6 —
they are **not** measurement evidence and do not fill any slot below.

**The three benchmark shots — all captured 2026-08-07:**

1. [`evidence/task-manager-npu.png`](evidence/task-manager-npu.png) — Task Manager →
   Performance → **NPU** during prefill of `hermes -z "assess the current incident"`, with
   the CPU pane in the same frame at 11%. The one-glance "it really is the NPU" shot.
2. [`evidence/hwinfo-power.png`](evidence/hwinfo-power.png) — HWiNFO on the same system
   power rail used for the energy benchmark: the load period peaks near 32 W and settles to
   11.4 W current / 11.3 W minimum, corroborating the 11.66 W idle baseline the +6.3 W
   figure is measured against.
3. [`evidence/qairt-visualizer.png`](evidence/qairt-visualizer.png) — QAIRT Visualizer
   **Performance** panel over per-op Hexagon execution of `prompt_ar128_cl512_2_of_4`
   (20 inferences, `burst`). The y axis is cycles; the twelve repeating spike groups are
   the transformer blocks in bundle part 2.

### How shot 3 was produced, and why it is a phone capture

Worth stating plainly, because it is not the obvious route and a judge may ask.

The Visualizer chooses a panel by regex-matching an `artifact_type` key in the report. Of
the QAIRT profiling readers, the only one emitting a report its performance parser accepts
is `libQnnJsonProfilingReader`, which ships in **QAIRT 2.45**. This laptop has QAIRT 2.32,
whose `qnn-profile-viewer` cannot load the 2.45 reader — it fails silently and writes a
zero-byte file. The 2.45 SDK available here is the `aarch64-android` build, so the capture
chain runs **on the phone** (Snapdragon 8 Elite, `hexagon-v79`), where tool and reader
versions match. Harness: [`bench/phone_profile.py`](../bench/phone_profile.py).

Two paths were tried first and are genuinely unavailable for this model: the **optrace** and
**chrometrace** readers both require a schematic file that is only emitted when you generate
the context binary yourself. This is a prebuilt Qualcomm AI Hub Genie bundle loaded through
`--retrieve_context`, so no schematic exists and both readers refuse with *"No Valid Input
Schematics"* — on the laptop and on the phone alike.

The reader's JSON carries `{metadata, messages}` and no `artifact_type`, so the Visualizer
would not classify it even though its own performance parser consumes exactly that shape.
[`bench/tag_qnn_profile.py`](../bench/tag_qnn_profile.py) adds that **one key** and changes
nothing else — every number rendered in the screenshot is the reader's own output. The
tagged report is committed at
`bench/artifacts/phone-profile/prompt_ar128_cl512_2_of_4-qnn-profile-tagged.json.gz`, so the
screenshot can be reproduced by opening that file in the Visualizer.

Per-op evidence for the **laptop** NPU is not screenshot-based: it is the 41 profiled graphs
under `bench/artifacts/out/` (`profile.csv` per graph), summarised in
[BENCHMARKS.md](BENCHMARKS.md).

Use **PNG, under `docs/`** — `.gitignore` blocks all image formats repo-wide
(face-capture safety) and re-allows only `docs/**/*.png` (`.gitignore:31-33`). A JPG, or a
PNG anywhere else, will silently fail to commit.
