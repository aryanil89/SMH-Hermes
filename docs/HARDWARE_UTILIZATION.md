# Hardware Utilization Plan

Available hardware: a Snapdragon X Elite Copilot+ PC, a Samsung Galaxy S25 Ultra (Snapdragon 8 Elite
for Galaxy), an Arduino UNO Q (Qualcomm QRB2210), and the QUAD-Client SDK already set up locally
at `QUAD-Client-main/`. Finalized architecture below, superseding earlier drafts.

> **Verified against the hackathon deck's resource links on 2026-08-03.** Every URL in
> `Snapdragon Multiverse Hackathon_Internal.pdf` was fetched; findings are folded in below and the
> full per-URL knowledge base lives in the `hackathon-resources` skill (at the QUAD workspace root,
> outside this repo — the deck contains event credentials that must not be committed here).
> Headline results: GenieX + Qwen3-4B is confirmed correct and the exact endpoint is known; the
> S25 Ultra stretch goal is de-risked by an official Android AAR; QAIRT Visualizer is added as a
> profiling artifact; and the one official resource covering the UNO Q sensor path is a dead link.

## QUAD's role in this project

QUAD is specifically build-time tooling to get Qwen3-4B running on the X Elite's NPU, plus
benchmarking — not the runtime serving path (that's GenieX) and not the agent/MCP-tool code
itself (that's hand-written). Concretely, mapped to the 5-day plan:

**Day 1 — getting the model onto the NPU:**
- `quad-detect` — confirms the laptop's NPU/QNN drivers actually work before anything is built on
  top of it. This is the Day-1 go/no-go check.
- `quad-npu-prereqs` — verifies the QNN SDK/driver stack is correctly installed.
- `quad-recommend` — feed it "Qwen3-4B + windows-x-elite + interactive use case" and it produces a
  concrete quantization (INT8 vs INT4) and runtime (NPU vs GPU) recommendation with rationale,
  instead of guessing.
- `quad-convert` / `quad-build-npu-bundle` / `quad-executorch` — does the conversion/quantization
  work, if the prebuilt NexaAI/AI-Hub Qwen3-4B bundle needs adjusting rather than being usable
  as-is.
- `quad-qnn-runtime-debug` — if the bundle loads but silently falls back to CPU or errors, this is
  the tool for diagnosing why — directly relevant to the NPU risk already flagged.
- `quad-doctor` — general toolchain health check if something upstream breaks (venv, SDK
  versions, drivers).

**Day 4-5 — benchmarking:**
- `quad-profile` — real P50/P95/P99 latency, throughput, and power numbers for the Qwen3-4B NPU
  bundle. This is the benchmark slide, not something to fake.
- `quad-orchestrate` — NPU vs CPU vs GPU allocation percentages and flags any ops that fell back
  off the NPU — the "on-device acceleration" proof.
- **QAIRT Visualizer** ([docs](https://docs.qualcomm.com/doc/80-87189-1/topic/overview.html)) — added
  after reviewing the deck's resources; not previously in this plan. Where `quad-orchestrate` reports
  *that* ops fell off the NPU, the Visualizer shows *which ops and why*: op-by-op execution-time
  trace, side-by-side source-vs-compiled op mapping, HTP analysis summaries, and accuracy-snooping
  views for quantization damage. Accepts DLC / ONNX / QNN JSON / ExecuTorch among others. Two uses
  here: (1) the highest-value *visual* artifact for the 40-point Technical Implementation score, and
  (2) the diagnostic of choice if the bundle silently falls back to CPU — pair it with
  `quad-qnn-runtime-debug`.

**If the Arduino UNO Q bonus is pursued:**
- `quad-unoq` — the SSH/ADB deploy/status/logs/perf commands to get telemetry off the board for
  the real environmental/physical-monitoring tool.

**What QUAD explicitly does not do:** it doesn't write the Hermes Agent config, the MCP tool
servers, or the Telegram wiring — those are separate work. And in the final architecture it isn't
the inference server either (`quad serve`'s API isn't OpenAI-compatible, which is why GenieX is
serving the model directly) — QUAD's job ends at "model is converted, verified on the NPU, and
profiled."

## Snapdragon X Elite laptop — inference host (primary)

- **Runtime: Qualcomm GenieX**, not Ollama (confirmed CPU-only on ARM64, no working NPU path) and
  not QUAD's own `quad serve` (custom tensor JSON API, would have needed a hand-written shim).
  GenieX runs NPU-optimized bundles on the Hexagon NPU and **natively serves an
  OpenAI-compatible endpoint** — Hermes Agent points at it directly as a custom provider, no
  adapter layer required. This removed the `shim/` scaffold from the repo.
  Verified from [github.com/qualcomm/geniex](https://github.com/qualcomm/geniex): Windows ARM64
  (Snapdragon X / X Elite) supported; **endpoint is `http://127.0.0.1:18181/v1`** — that is the
  literal base URL to put in the Hermes provider config; install via the Windows installer or
  `pip install geniex`; accepts both AI Hub precompiled bundles (via QAIRT) and raw GGUF (via
  llama.cpp); dispatches across Hexagon NPU / Adreno GPU / CPU. GenieX's own docs use Qwen3-4B as a
  worked example, so this is the vendor-blessed pairing rather than an inference on our part.
- **Fallback if the GenieX NPU path fails on Day 1**: AnythingLLM's NPU provider, serving at
  `http://localhost:3001/api/v1` — the pattern in
  [simple-npu-chatbot](https://github.com/thatrandomfrenchdude/simple-npu-chatbot) (needs `api_key`
  from its Developer API plus a `workspace_slug`). Explicitly a fallback, not a co-equal option: its
  API is **not** OpenAI-shaped, so taking it reintroduces the `shim/` layer GenieX let us delete.
  Decide by end of Day 1 — switching later is expensive.
- **Model: Qwen3-4B-Instruct-2507** (NPU-optimized bundle — NexaAI or Qualcomm AI Hub build), chosen
  over Phi-3.5-mini-instruct and Phi-4-mini specifically for tool-calling reliability, since the
  whole pitch depends on the agent correctly driving MCP tool calls:
  - Qwen3 family has confirmed strong native tool/function-calling (heavy agentic/function-call
    training data), with existing NPU bundles. Confirmed present on AI Hub under the GenieX runtime
    filters (`?runtime=geniex_qairt,geniex_llamacpp`) — so a prebuilt bundle exists and conversion
    work is likely avoidable entirely. **Exact catalog name is `Qwen3-4B-Instruct-2507`**; plain
    "Qwen3-4B-Instruct" is not a catalog entry, so use the full name in slides and configs.
  - Phi-3.5-mini's tool-calling is anecdotal/unofficial — a weaker bet for a live demo.
  - Phi-4-mini isn't in QUAD's or AI Hub's NPU bundle catalog at all; would need the unoptimized
    raw-GGUF fallback path.
  - Context: Hermes Agent needs ~64K context for memory/skills overhead; Qwen3-4B supports this
    (native 32K, extendable).
- **QUAD-Client's role**: build-time only (convert/detect/profile), not the serving layer — see
  [QUAD's role in this project](#quads-role-in-this-project) above for the full breakdown.
- **Agent host**: Hermes Agent **native on Windows ARM64** via `install.ps1`. The earlier
  "WSL2, native build unconfirmed" plan is obsolete — Nous's platform-support doc now lists Windows
  10/11 aarch64 as **Tier 1**, `install.ps1` has dedicated native-ARM64 logic, and the native
  Windows guide is the primary documented path ([AUDIT_2026-08-03.md](AUDIT_2026-08-03.md) §2.2).
  This removed what was previously the plan's #1 risk. Note for anyone tempted back into WSL2:
  `127.0.0.1:18181` is **not** reachable from inside WSL2 without mirrored networking, so GenieX
  serving on the Windows side would be invisible to a WSL2-hosted agent.

## Samsung Galaxy S25 Ultra — mobile terminal + stretch inference target

- **Baseline**: runs Telegram, talks to the PC-hosted Hermes Agent. This is what the pitch needs
  and should be working before anything else on the phone is attempted.
- **Stretch goal (in scope per decision)**: the S25 Ultra is Snapdragon 8 Elite (SM8750-AC, 12 GB RAM) — same `android-8elite`
  QUAD target, same GenieX/Qwen3-4B path as the laptop. Attempt a second on-device inference
  instance on the phone for a "same agent, two devices" demo beat and a phone-vs-laptop NPU
  benchmark data point. Build this *after* the laptop path and the Telegram baseline are both
  solid — it's additive, not a dependency for the core demo.
  **Materially de-risked by the deck review**: GenieX ships an official Android library —
  `implementation("com.qualcomm.qti:geniex-android:0.3.1")` — and its README lists Snapdragon
  8 Elite as a supported target. This drops the stretch goal from "unknown, needs research" to
  "add a Gradle dependency and load the same bundle family", which raises its odds enough to be
  worth attempting rather than merely aspiring to.

## Arduino UNO Q — bonus, backs one real data source

Not used for the **agent's** LLM inference — a deliberate design choice, not a hardware
impossibility. **Update 2026-08-06**: it does now run a small, separate LLM of its own (SmolLM2-135M,
on-device activity correlation from the sensor feed) — see the note further down this section and
[ONDEVICE_ACTIVITY.md](ONDEVICE_ACTIVITY.md). What follows below (no headroom for a 4B tool-calling
model, no accelerator to help) is why the *agent's* brain still stays on the laptop.

**Corrected specs** (the earlier "1 TOPS, 2GB RAM, INT8-only, confirmed too weak for any LLM" line
was wrong on every count — see [AUDIT_2026-08-03.md](AUDIT_2026-08-03.md) §1.5, which traced it to
QUAD's own `quad-unoq` reference table rather than Qualcomm primary docs):

- The **QRB2210 has no NPU at all**. Qualcomm's own materials state AI models run on the GPU and CPU.
- **No official TOPS figure exists** for this part, so any TOPS number here is fabricated.
- The board ships in **2GB and 4GB** variants (which resolves the apparent conflict with deck slide
  12's "4GB" — both figures are real, for different SKUs). Confirm which one this board is via
  `quad-detect` before any number goes on a slide.
- **INT8-only is false** — Arduino's own guide runs Q4 GGUF models, and Arduino officially
  demonstrates SmolLM2-135M and Llama-3.2-1B-Q4 on the board.
- **Update 2026-08-06 — no NPU, but there is a GPU.** No Hexagon/DSP node exists (reconfirmed via
  `dmesg`/`lsmod`), but the QRB2210 has a real, working Adreno 702 GPU this doc didn't previously
  mention — `vulkaninfo` enumerates it as `Turnip Adreno (TM) 702` via Mesa's open-source Vulkan
  driver. On-device inference now runs here (SmolLM2-135M-Instruct, on-device activity correlation
  from the sensor feed): CPU, not GPU — Vulkan/Turnip was measured and lost decisively, see
  [ONDEVICE_ACTIVITY.md](ONDEVICE_ACTIVITY.md).

So the honest framing is: a small LLM *can* run here, but there is nowhere near the headroom for the
4B tool-calling model the agent needs, and no NPU to accelerate it — the laptop keeps the brain.
The board's job is sensing, which is what a board with GPIO and an MCU is actually for.

⚠️ The board also has **no onboard environmental sensors**. Temperature/distance/button data comes
from external **Modulino** modules on the Qwiic bus (`Wire1`) — see [../uno-q/README.md](../uno-q/README.md).
There is no true leak sensor on hand. **Button C** is the working stand-in: press logs
`leak_detected`, release logs `leak_cleared`. The **Distance** module was also wired as a
water-level probe, but that path is **not currently reachable** — as of 2026-08-05 `sensor_tick`
carries temperature and humidity only, and the laptop reads distance from the newest line, so
`UNOQ_LEAK_DISTANCE_MM` has nothing to test against. The module now serves as a presence sensor
instead (`object_entered` / `object_left` across a 1000mm threshold).

⚠️ **The official RPC resource is a dead link.** The deck's Arduino resource
(`github.com/qualcomm/edge-ai-labs-arduino/tree/main/rpc`) 404s at both the path and the repo root;
`gh api` confirms no such repo exists under the `qualcomm` org and a repo search finds no
Qualcomm-owned Arduino project. It was the only listed resource covering Linux↔STM32 RPC — i.e.
exactly this sensor path. Not a blocker, since board access already works (adb; Qwiic sensors on
`Wire1`), but it does mean **there is no official reference to fall back on**: use Arduino's own
Bridge/App Lab tooling, and raise it in the Discord support channel rather than re-attempting the
URL. This slightly increases the case for keeping the UNO Q off the critical path.
Included as a bonus per decision: it backs the **environmental/physical-monitoring** MCP tool
(temperature, humidity, leak detection) with real sensor data instead of mocked data, driven via
QUAD's `quad-unoq` skill (SSH/ADB deploy). This is the correct real-world role for a
microcontroller — a real datacenter (DCIM) use case, not a stand-in for a software metric.
Storage capacity was considered for this slot earlier but doesn't fit: capacity is a filesystem
metric, not something a microcontroller senses. Environmental sensing has the added benefit of
being **physically triggerable during a live demo** (breathe on the sensor, simulate a leak) in a
way no software-mocked tool can be — see [Demo beats worth scheduling](#demo-beats-worth-scheduling).
Not on the critical path — if it slips, the demo just drops that one tool with no loss to the core
pitch.

## MCP tool data strategy (hybrid, per decision)

Generalized from the original pitch's CI/CD-specific framing — the actual scope is general
datacenter health (network, storage, server, or whatever else fits the demo scenario), not
Jenkins builds specifically.

| Category | Example signal | Data source |
|---|---|---|
| Network | link/latency/connectivity issues between racks or zones | Mocked |
| Storage | capacity, risk of hanging or failure | Mocked (real disk stats off the dev machine are possible, but not a dependency) |
| Server / compute | node health, service uptime, resource exhaustion | Mocked |
| Environmental / physical | temperature, humidity, leak detection | **Real** — Arduino UNO Q sensor |

Rationale: wiring real network/storage/server data sources is integration work with no guaranteed
payoff in a 5-day window and real risk of breaking live during a demo. One real, physically
tangible data source — the environmental sensor, the one category that's a genuine hardware use
case rather than a software metric — is enough to make the "not everything is mocked" point to
reviewers without betting the whole demo on live infra integrations.

## Proactive alerting

The pitch so far is entirely pull-based (engineer asks, agent answers). Hermes Agent already runs
as a persistent background daemon with built-in scheduled/cron tasks and can message out over its
Telegram gateway on its own initiative, not just reply to incoming messages — so proactive
alerting is a configuration task, not new engineering.

Shape: a scheduled check of a watched signal (most naturally the environmental sensor, but any of
them) that pushes a Telegram message to the phone when a threshold is crossed, instead of waiting
to be asked.

**As built** this turned out *not* to be a configuration task. It began as a Hermes cron job and
had to move to a dedicated process ([`watch-loop.ts`](../mcp-tools/src/alert-skill/watch-loop.ts),
15 s tick), because Hermes cron cannot tick faster than about two minutes for three structural
reasons and the wait for the next tick was measured at **~86% of the worst-case sensor-edge-to-phone
latency**. The measurement, the causes and the cutover are in [WATCHDOG.md](WATCHDOG.md). Either way
the point below stands: **no LLM runs on a tick**, so the watchdog costs nothing on the NPU and does
not compete with interactive queries.

This doubles as a self-improvement demo: rather than hand-configuring the watch skill up front,
frame it as something the agent creates itself after being asked about the same signal a couple of
times ("I noticed you keep asking about this — I'll watch it and tell you"). See
[Demo beats worth scheduling](#demo-beats-worth-scheduling).

## Demo beats worth scheduling

Differentiators discussed that need to be actual scheduled demo moments, not just architecture
claims, or they won't land:

- **Self-improvement, shown live** — run one incident scenario twice; the second run is visibly
  faster/better because the agent created a skill from the first. **Verified 2026-08-03** (closes
  the research item from [AUDIT_2026-08-03.md](AUDIT_2026-08-03.md) §1.6): comparable open-source
  incident tools ship capabilities *authored ahead of time* —
  [K8sGPT](https://github.com/k8sgpt-ai/k8sgpt) ships **20+ pre-built analyzers** (14 enabled by
  default, plus optional ones) — "SRE experience codified into its analyzers" — with LLM
  explanation, plus
  auto-remediation that is [alpha, "**highly** experimental and not ready for use in a production
  environment", and off by default](https://github.com/k8sgpt-ai/k8sgpt-operator/blob/main/AUTO_REMEDIATION.md)
  (`autoRemediation.enabled: true` required);
  [HolmesGPT](https://www.cncf.io/blog/2026/01/07/holmesgpt-agentic-troubleshooting-built-for-the-cloud-native-era/)
  is runbook-driven ("without runbooks, the model just guesses"; a controlled test scored the same
  model 4.6/5 with runbooks vs 3.6 without —
  [CNCF, 2026-04](https://www.cncf.io/blog/2026/04/21/auto-diagnosing-kubernetes-alerts-with-holmesgpt-and-cncf-tools/)).
  Neither *authors new capability from its own investigations*. Be precise on this if pressed:
  HolmesGPT **can read** past incidents — the Robusta toolset's four `fetch_*` tools expose
  historical findings and config changes, documented as
  ["read-only access"](https://holmesgpt.dev/0.20.0/data-sources/builtin-toolsets/robusta/) — but
  its *procedures* (runbooks) are human-written in advance. The differentiator is write-back, not
  recall. Hermes's L4 skills are
  [self-written at runtime](https://hermes-agent.nousresearch.com/docs/): the docs describe
  "autonomous skill creation", "skill self-improvement during use", "agent-curated memory with
  periodic nudges" and "FTS5 cross-session recall with LLM summarization". **Stage wording**: *"their capabilities are authored ahead of time — analyzers,
  runbooks; Hermes authors new skills at runtime from its own sessions."* Say what's documented;
  avoid the unfalsifiable absolute "none of them can learn."
- **Proactive alert + physical trigger** — trip the UNO Q's environmental sensor live on stage,
  phone gets a real push notification in real time. The single most visceral moment available.
- **Compute failover to the second NPU in the room — built and verified live 2026-08-06.** Arm
  with `scripts\demo-failover-ON.ps1` (it disables the supervisor that would otherwise resurrect
  GenieX in ~15s, and preflights the phone), kill GenieX on stage, and the next Telegram question
  is answered by the S25 Ultra's 8 Elite NPU over `adb` — labeled *degraded mode, no tools*,
  **~12s end-to-end** (measured). This is *compute* failover, not an offline claim — Telegram
  still needs internet (see the beat below for why that distinction is load-bearing). Restore
  with `demo-failover-OFF.ps1`. Details: [../hermes-hooks/README.md](../hermes-hooks/README.md).
- **On-device inference-without-cloud proof — scoped correctly.** Disconnect WiFi/internet and
  query the agent **directly on the laptop, not through Telegram**, to prove the LLM+MCP-tool
  reasoning itself needs no cloud. Telegram cannot be part of this specific demo beat — the
  Telegram Bot API itself requires internet to relay messages, so cutting connectivity would kill
  the phone channel entirely, not just a cloud LLM call. Conflating the two would make an
  undeliverable demo promise.
  **Upgrade available**: [simple-whisper-transcription](https://github.com/thatrandomfrenchdude/simple-whisper-transcription)
  is a working local voice path — Whisper Base En from AI Hub, QNN-accelerated, 16kHz in 4-second
  chunks, developed on X Elite hardware, with a standalone ONNX variant as fallback. With it, the
  disconnected beat becomes *voice in → NPU reasoning → answer out, WiFi visibly off*, which lands
  harder than typing at a terminal. Consequence for the phone: voice is no longer something only the
  phone can offer, so the S25 Ultra's justification has to rest on **mobility**, not audio.
- **Two-device cooperation**, if the phone-inference stretch goal lands — the phone contributing
  something the laptop can't (mobility — see the voice note above), not just acting as a remote
  control.
- **Beat the named baseline.** The deck's own reference agent,
  [local-agent](https://github.com/thatrandomfrenchdude/local-agent) (found only via a QR code on
  slide 14 — it has no row in the resources table), is a plain Python tool-loop against a local LLM
  server with **no MCP, no memory, no proactive behavior**. It's the closest official prior art to
  Hermes and it is strictly simpler. Worth one presentation slide contrasting against it: same
  on-device premise, but MCP tools + self-improvement + push alerting. Anyone scoring "creativity
  and uniqueness" (25 pts) need a reference point, and supplying it beats hoping they infer one.

## Cloud-dependency check (unchanged from FEASIBILITY.md)

QUAD's own remote MCP server (`quad.infra.foundries.io`) is build-time only (model conversion,
profiling, codegen) — no NPU, no runtime inference, no chat data. Using QUAD to build/profile the
NPU bundle does not reintroduce a cloud dependency at demo time. GenieX itself runs and serves
fully locally as well. The **Telegram transport caveat from [FEASIBILITY.md](FEASIBILITY.md) is
still open and unrelated to this hardware plan** — messages relay through Telegram's servers
regardless of how the LLM runs, so the "no cloud hop / air-gapped" pitch language still needs
either softening or a real local-only transport swap. Not decided yet.

**Cloud inference offer: declined, on purpose.** The deck's AI Inference Suite section (slides
17–27) is Cirrascale Inference Cloud on **Qualcomm Cloud AI 100 Ultra**
(`aisuite.cirrascale.com`), with free credits on offer, and it explicitly blesses *hybrid* designs —
its worked example is STT local → LLM cloud → TTS local. Taking it would mean putting a cloud hop
in the middle of a project whose entire differentiator is that there isn't one, so we don't. Logged
here because a reviewer is likely to ask why the credits went unused: the answer is "on-device **is**
the product", not "we ran out of time". Note this also makes the Telegram caveat above sharper — it
is now the *only* remaining cloud hop in the design, and therefore the only thing standing between
the pitch language and being literally true.

## Submission requirements that shape the build

Not logistics — these change what gets built, so they belong here. Full details and the QR-only form
URLs are in the `hackathon-resources` skill.

- **Deadline 12:00 PST Fri 7 Aug 2026**, one GitHub repo per team via a Microsoft Form. The deck
  contradicts itself (slides 6/7 say 12pm, slide 41 says 1pm PST) — build to 12:00. A raffle covers
  the first 15 teams to submit a proposal, so submitting early has value independent of quality.
- **Anyone must be able to install and run this on the Copilot+ PC from the README alone.** That makes the
  from-scratch setup instructions a deliverable with the same weight as code — 20 of 100 points are
  "ease of installation and use". Every mocked-vs-real data source needs to be stated so nothing
  looks broken when someone runs it without an UNO Q attached.
- **README must carry names and emails of every team member**, plus a LICENSE file. Missing either
  is a disqualification risk, not a deduction.
- **Technical Implementation is 40 points and it is a measurement bucket** — resource utilization,
  optimization, latency/performance, energy efficiency. Unbacked claims score zero. This is the
  reason `quad-profile`, `quad-orchestrate`, and the QAIRT Visualizer outputs must be *captured into
  the repo* rather than merely run once during development.
- **Every team member must submit the feedback form by Friday noon** or the team is ineligible, and
  **the team must demo live** to win anything.

## Summary of what changed from the original pitch
- Ollama → GenieX (the path we verified for genuine Hexagon NPU offload — Foundry Local and the
  Nexa SDK are plausible alternatives we didn't test, so "only path" would overclaim)
- Phi-4-mini → Qwen3-4B-Instruct-2507 (confirmed tool-calling reliability + NPU bundle availability;
  full catalog name matters)
- No shim needed (GenieX is natively OpenAI-compatible)
- UNO Q: bonus, backs one real tool, not a dependency
- S25 Ultra: Telegram baseline + on-phone inference as an explicit stretch goal
- Data: hybrid — one real source, rest mocked
- Tool categories generalized: network/storage/server/environmental, not CI/CD-specific
- Arduino UNO Q reassigned from storage-capacity (not a real sensor use case) to
  environmental/physical monitoring (a genuine, demo-triggerable DCIM use case)
- Added proactive/push alerting via Hermes Agent's existing cron + Telegram gateway, doubling as a
  self-improvement demo beat

### Added by the 2026-08-03 deck-resource review
- GenieX endpoint pinned: `http://127.0.0.1:18181/v1`; `pip install geniex`; NPU/GPU/CPU dispatch and
  both bundle + GGUF paths confirmed from the repo
- Model name corrected to the real catalog entry `Qwen3-4B-Instruct-2507`, confirmed present under
  AI Hub's GenieX runtime filters (prebuilt bundle likely ⇒ conversion possibly unnecessary)
- QAIRT Visualizer added as the per-op profiling + CPU-fallback diagnostic artifact
- S25 Ultra stretch goal de-risked by the official `com.qualcomm.qti:geniex-android:0.3.1` library
- Local Whisper voice path identified, strengthening the WiFi-off demo beat and shifting the phone's
  rationale to mobility alone
- AnythingLLM (`localhost:3001/api/v1`) recorded as the explicit Day-1 runtime fallback
- `local-agent` identified as the official baseline to contrast against in the presentation
- Cirrascale / Cloud AI 100 credits declined, with the reasoning recorded
- UNO Q: official RPC reference confirmed dead; RAM spec conflict (2GB vs deck's 4GB) flagged
