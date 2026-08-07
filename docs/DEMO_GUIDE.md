# Demo guide — the five-minute version

Hermes is an on-device AI ops engineer: a 4B-parameter LLM served from the Snapdragon X
Elite's Hexagon NPU watches a (mostly simulated) datacenter, explains incidents over real
sensors, pages a human, and gates physical access behind face recognition plus a mandatory
human decision. Everything below is either **measured** (with the measurement linked) or
**labeled simulated** — nothing in between.

## The demo sequence (~5 minutes)

| # | Beat | What you should see |
|---|---|---|
| 1 | Wall dashboard tour (30 s) | Live tiles at `:7788`; every simulated family is labeled as such; provenance-aware confidence on the assessment card |
| 2 | Ask the agent a real question (Telegram or `hermes -z`) | Task Manager's **NPU** pane spikes while CPU stays low; each ~12.5K-token iteration runs ≈ 68 s on-device (60.9 s measured prefill + ~7 s decode); a full tool-calling turn chains 2+ iterations, so expect 2–4 min |
| 3 | Press **Button C** on the Arduino UNO Q | Leak event → watchdog pages the on-call phone in **15–30 s**; a known responder standing at the rack suppresses the duplicate page |
| 4 | Walk up to the rack | Presence → photo capture → `face-cpu` identity attempt → **human approve/deny** on the phone (or wall panel, which shows the held-in-memory photo) → audit trail |
| 5 | Kill GenieX (`demo-failover-ON`) and ask again | The **phone's** 8 Elite NPU answers over `adb` in ~**12 s**, delivered to Telegram and the wall labeled *degraded, no tools* |

Fallbacks if something is down on the day: Telegram blocked → hotspot (RUNBOOK §9); board
offline → readings labeled **mock** and the alert state machine refuses to move on them
(the mock can rarely invent a leak — ~3% of calls, always labeled mock on the wall — which is
why the board should be powered before judging starts: ~70 s boot);
GenieX dead → beat 5 *is* that failure; face backend dead → detection-only, and the human
approval gate still holds; phone unreachable → the wall's approval panel does the same job.

## Real vs. simulated vs. planned

| Status | What |
|---|---|
| **Real, measured** | NPU LLM serving (GenieX), energy/latency benchmarks, environmental sensors (UNO Q push log), face-cpu identity, access flow + audit trail, 15 s watchdog, phone-NPU failover, on-board activity inference (SmolLM2-135M running **on the UNO Q itself**, surfaced on the wall, folded into Telegram alerts, and — since 2026-08-07 — reported by the agent itself in `get_incident_assessment`), and **this laptop's own CPU/memory/uptime** as compute node `host-01` |
| **Simulated, labeled** | Network / storage telemetry and the six-node compute *rack* (mock MCP servers; the assessment sets `simulatedInputs: true` and the wall says so). Every compute node carries `source: "real"` or `"mock"`, so `host-01` is never confusable with the invented ones |
| **Planned, not built** | `face-npu` (same models on Hexagon), phone *serving* endpoint (today: one-shot failover, no tools), level-based leak threshold (demoted — Button C is the leak trigger) |
| **Unsupported today** | GPU tool-calling — fails in GenieX (`SDKError`), reproduced twice; capability matrix in [WORKLOAD_PLACEMENT.md](WORKLOAD_PLACEMENT.md) |

## The numbers (all measured; index with sources: [EVIDENCE.md](EVIDENCE.md))

| Claim | Number |
|---|---|
| NPU vs CPU prefill | **382 ± 8.3 tok/s vs 35 ± 7.2** (~11×) |
| Real 12.5K-token agent iteration | **~68 s** NPU (60.9 s measured prefill + ~7 s decode) vs ~371 s modeled CPU; a tool-calling turn = 2+ iterations = 2–4 min |
| Energy | **471 J/query** NPU; CPU burns **~8.7× more per prompt-token**; +6.3 W vs +21.3 W system lift |
| Sensor edge → phone | **15–30 s** via the watchdog (down from a measured 102 s worst case) |
| Phone (8 Elite) NPU | **1,918 ± 16.9 tok/s prefill / 23.1 ± 1.3 decode** — different config, labeled, not 1:1 with the laptop row |
| Phone failover | **12.0 s** message → delivered degraded answer |
| Tests | **30 files / 361 tests**, all passing; strict TypeScript build |

## Where the rubric evidence lives

| Rubric category | Start here |
|---|---|
| Technical Implementation (40) | [EVIDENCE.md](EVIDENCE.md) → RESULTS.md, per-op Hexagon profiling, prompt-composition optimization, failover |
| Use-Case & Innovation (25) | README intro, [POSITIONING.md](POSITIONING.md), the access sentry (beat 4) |
| Deployment & Accessibility (20) | README § Quickstart — rung 1 is `npm install && npm run build && npm test` on any Node 22+ machine, ~5 min, no hardware |
| Presentation & Documentation (15) | This guide, candid README § Today vs. planned, [RUNBOOK.md](RUNBOOK.md) troubleshooting from real incidents, dashboard UI screenshots in [evidence/wall/](evidence/wall/) |
