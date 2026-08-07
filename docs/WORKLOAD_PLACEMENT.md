# Workload placement — NPU / GPU / CPU

Answers one question directly: **given the policy "demanding AI/LLM work on the NPU, lighter
AI/LLM work on the GPU, everything else on the CPU" — is this project's placement balanced
against it today?** Audited 2026-08-05, against the Snapdragon X Elite demo laptop
(X1E80100, Hexagon NPU v73, Adreno GPU). No runtime code changed as a result of this audit —
see [Verdict](#verdict) for why.

## Why this isn't a QUAD profiling run

The issue that prompted this asks for QUAD to do the profiling. It can't, for two independent
reasons, both already on record elsewhere in this repo:

1. **QUAD cannot reach this laptop's NPU.** [GLOSSARY.md](GLOSSARY.md) is explicit: `profile_device`
   "cannot reach this laptop — the QUAD server is a remote x86 VM with no Hexagon." QUAD's own
   role here is build-time-only — converting and profiling a model *bundle* before it ships, not
   observing a running process on this specific machine. [ARCHITECTURE.md](ARCHITECTURE.md) and
   GLOSSARY.md both describe QUAD and the runtime as **disjoint graphs** that share only the
   laptop as a physical host.
2. **The NPU numbers actually in use didn't come from QUAD.** They came from GenieX's own served
   benchmarks (`llm-serving-bench/`) using `qnn-net-run` / `qnn-profile-viewer` directly against
   the running server. [AUDIT_2026-08-03.md](AUDIT_2026-08-03.md) already flagged `quad-profile`'s
   LLM-bundle capability as **unverified** for exactly this reason.

So this document reasons from the profiling that was actually run and is already in the repo,
rather than re-attempting a tool call that's architecturally unable to answer the question.

## What's actually running

| Process | What it does | Real AI/LLM compute? |
|---|---|---|
| **GenieX** (`geniex.exe`, port 18181) | Serves Qwen3-4B-Instruct-2507 for every agent turn | **Yes — the only one** |
| `network-server.ts`, `storage-server.ts`, `compute-server.ts` | Mocked telemetry (`get_network_status` etc.) — synthetic numbers, no model | No |
| `environmental-server.ts` | Real sensor I/O from the UNO Q, mock fallback | No — I/O, not inference |
| `rules-server.ts`, `assessment-server.ts` | Rule evaluation / arithmetic scoring, microseconds | No |
| `dashboard/server.js` (the wall) | HTTP + SSE + static files | No |
| `alert-skill/watch-loop.ts` | 15s poll/decide loop | No — [HARDWARE_UTILIZATION.md](HARDWARE_UTILIZATION.md#proactive-alerting) is explicit that **no LLM runs on a tick** |

Everything in the second group is a lightweight Node/TypeScript process already running on CPU by
default — there is no accelerator dial for a mocked data generator or a rule check, and moving one
to the NPU or GPU would not be an optimization, it would be a category error. The policy's "all
other workloads on the CPU" clause is already satisfied by construction, not by a decision that
needed making.

That leaves exactly one real AI/LLM workload to place: GenieX.

## GenieX: NPU, and why GPU isn't a live alternative today

`--compute npu` is production (`geniex-supervisor.ps1` default, locked in per
[PROGRESS.md](../PROGRESS.md) item 2). Measured, not assumed —
[llm-serving-bench/RESULTS.md](../llm-serving-bench/RESULTS.md):

| Backend | Prefill | Decode | Tool-calling | Verdict |
|---|---|---|---|---|
| **NPU** | 382 ± 8.3 tok/s | 14.2 tok/s | **pass** | production |
| Hybrid | 203 tok/s | 17.3 tok/s | pass | runner-up, not an upgrade (82% of an agent turn is prefill, where NPU wins outright) |
| GPU | ≈650 tok/s prefill, ≈110 tok/s decode — **but only in a tool-free request** | — | **fails**: `SDKError(Model loading failed)` / HTTP 500 on any `tools`-bearing call | **disqualified for this workload** |
| CPU | 35 ± 7.2 tok/s | — | pass | last-resort fallback — runs anywhere (x64 included) but ~11× slower prefill and ~8.7× more energy per prompt-token |

The GPU failure is reproduced twice — `llm-serving-bench/serve-Q4_0-gpu.log` and the archived
`archive/RESULTS-20260805-103522.md` — and every real agent turn on this project uses tools, so
GPU isn't "the lighter tier we chose not to use," it's currently broken for the one workload that
exists. Routing anything to it today would be a regression, not a rebalance.

**If a GenieX release fixes GPU + tool-calling**, GPU's own measured throughput (nearly 2× NPU
prefill, tool-free) would make it worth a real re-check — this was already a standing follow-up
before this issue, not a new one: `python bench.py --modes gpu` per RESULTS.md's own conclusion.
Nothing about today's audit changes that follow-up; it just confirms it hasn't happened yet and
explains why acting on it now would be premature.

## The one candidate for the GPU tier — built, but on CPU, not GPU

The policy's "less demanding AI/LLM workload → GPU" tier has an obvious occupant: face
identification. `ACCESS_IDENTITY_METHOD` lists `face-npu` and `face-cpu` as rungs in the
[identity ladder](../phone/README.md#the-identity-ladder) — a small embedding model, run
per-capture rather than per-token-of-conversation, async to the interactive chat path. That's a
materially lighter and less latency-critical job than driving the primary agent.

**As of 2026-08-06, it's built** — `face-cpu` (InsightFace buffalo_s: SCRFD-500MF detector +
ArcFace MobileFaceNet recognizer via onnxruntime) is live, verified against known matches scoring
0.85/0.79. It runs on **CPU**, not GPU: Phase A deliberately chose CPU for something deterministic
and stable inside a 24-hour ship window — the same non-NPU fallback this doc already anticipated.
`face-npu` (the Hexagon NPU rung) and a GPU-executing rung are both still unbuilt, so this audit's
conclusion is unchanged: nothing has actually landed on the GPU tier. Building an NPU or GPU
variant is a separate, larger piece of work than a placement decision, and out of scope for this
audit.

## Verdict

| Policy tier | What should be there | What's there today |
|---|---|---|
| NPU — demanding AI/LLM | The primary model | GenieX / Qwen3-4B — ✅ |
| GPU — lighter AI/LLM | A secondary, less latency-critical model | Nothing built on GPU; GPU is also currently broken for this project's tool-calling workload regardless |
| CPU — everything else | Mocked telemetry, real sensor I/O, rules, the wall, the watchdog, **and now face-cpu identification** | Already there — these were never accelerator candidates, and face-cpu (built 2026-08-06) slotted into the same CPU tier |

**Current placement already matches the stated policy for everything that exists.** There is no
rebalancing action available today: the one real NPU-class workload is correctly on the NPU with
numbers to back it, face identification landed on CPU exactly where this doc already expected the
non-NPU fallback to sit, and the GPU tier still has no occupant **on this laptop**. The two concrete, already-known
triggers for revisiting this are unchanged by this audit: a GenieX release that fixes GPU +
tool-calling, or an NPU-executing `ACCESS_VISION_SCRIPT` landing.

**Update 2026-08-06 — a GPU tier occupant showed up, on the UNO Q, not the laptop.** The board's
QRB2210 turned out to have a real Adreno 702 GPU (Turnip/Vulkan) that this doc and
[HARDWARE_UTILIZATION.md](HARDWARE_UTILIZATION.md) hadn't previously noted — see
[ONDEVICE_ACTIVITY.md](ONDEVICE_ACTIVITY.md) for how it was found. It was measured against CPU for
on-device SmolLM2-135M inference and lost decisively (crashed under load, ~32x slower decode even
when it didn't crash — no matrix cores on this integrated GPU). Same conclusion this doc already
reached for the laptop's GPU tier, independently arrived at on different silicon: a detected,
working accelerator is not automatically a faster one for a given workload. The verdict table above
is laptop-scoped and unchanged by this.
