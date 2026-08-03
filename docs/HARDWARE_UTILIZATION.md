# Hardware Utilization Plan

Available hardware: a Snapdragon X Elite Copilot+ PC, a Samsung Galaxy S25+ (Snapdragon 8 Elite
for Galaxy), an Arduino UNO Q (Qualcomm QRB2210), and the QUAD-Client SDK already set up locally
at `QUAD-Client-main/`. Finalized architecture below, superseding earlier drafts.

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
  off the NPU — the "on-device acceleration" proof for judges.

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
- **Model: Qwen3-4B-Instruct** (NPU-optimized bundle — NexaAI or Qualcomm AI Hub build), chosen
  over Phi-3.5-mini-instruct and Phi-4-mini specifically for tool-calling reliability, since the
  whole pitch depends on the agent correctly driving MCP tool calls:
  - Qwen3 family has confirmed strong native tool/function-calling (heavy agentic/function-call
    training data), with existing NPU bundles.
  - Phi-3.5-mini's tool-calling is anecdotal/unofficial — a weaker bet for a live demo.
  - Phi-4-mini isn't in QUAD's or AI Hub's NPU bundle catalog at all; would need the unoptimized
    raw-GGUF fallback path.
  - Context: Hermes Agent needs ~64K context for memory/skills overhead; Qwen3-4B supports this
    (native 32K, extendable).
- **QUAD-Client's role**: build-time only (convert/detect/profile), not the serving layer — see
  [QUAD's role in this project](#quads-role-in-this-project) above for the full breakdown.
- **Agent host**: Hermes Agent under WSL2 on the laptop (native Windows-ARM64 build unconfirmed;
  WSL2 is Nous's own documented Windows path) — verify this first, Day 1.

## Samsung Galaxy S25+ — mobile terminal + stretch inference target

- **Baseline**: runs Telegram, talks to the PC-hosted Hermes Agent. This is what the pitch needs
  and should be working before anything else on the phone is attempted.
- **Stretch goal (in scope per decision)**: the S25+ is Snapdragon 8 Elite — same `android-8elite`
  QUAD target, same GenieX/Qwen3-4B path as the laptop. Attempt a second on-device inference
  instance on the phone for a "same agent, two devices" demo beat and a phone-vs-laptop NPU
  benchmark data point. Build this *after* the laptop path and the Telegram baseline are both
  solid — it's additive, not a dependency for the core demo.

## Arduino UNO Q — bonus, backs one real data source

Confirmed too weak for any LLM inference (1 TOPS, 2GB RAM, INT8-only) — not attempted.
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
judges without betting the whole demo on live infra integrations.

## Proactive alerting

The pitch so far is entirely pull-based (engineer asks, agent answers). Hermes Agent already runs
as a persistent background daemon with built-in scheduled/cron tasks and can message out over its
Telegram gateway on its own initiative, not just reply to incoming messages — so proactive
alerting is a configuration task, not new engineering.

Shape: a cron-triggered Hermes skill periodically checks a watched MCP tool (most naturally the
environmental sensor, but any of them) and pushes a Telegram message to the phone when a
threshold is crossed, instead of waiting to be asked.

This doubles as a self-improvement demo: rather than hand-configuring the watch skill up front,
frame it as something the agent creates itself after being asked about the same signal a couple of
times ("I noticed you keep asking about this — I'll watch it and tell you"). See
[Demo beats worth scheduling](#demo-beats-worth-scheduling).

## Demo beats worth scheduling

Differentiators discussed that need to be actual scheduled demo moments, not just architecture
claims, or they won't land with judges:

- **Self-improvement, shown live** — run one incident scenario twice; the second run is visibly
  faster/better because the agent created a skill from the first. None of the comparable
  open-source tools (HolmesGPT, K8sGPT, Kubernaut, Robusta) do this.
- **Proactive alert + physical trigger** — trip the UNO Q's environmental sensor live on stage,
  phone gets a real push notification in real time. The single most visceral moment available.
- **On-device inference-without-cloud proof — scoped correctly.** Disconnect WiFi/internet and
  query the agent **directly on the laptop, not through Telegram**, to prove the LLM+MCP-tool
  reasoning itself needs no cloud. Telegram cannot be part of this specific demo beat — the
  Telegram Bot API itself requires internet to relay messages, so cutting connectivity would kill
  the phone channel entirely, not just a cloud LLM call. Conflating the two would make an
  undeliverable demo promise.
- **Two-device cooperation**, if the phone-inference stretch goal lands — the phone contributing
  something the laptop can't (mobility/voice), not just acting as a remote control.

## Cloud-dependency check (unchanged from FEASIBILITY.md)

QUAD's own remote MCP server (`quad.infra.foundries.io`) is build-time only (model conversion,
profiling, codegen) — no NPU, no runtime inference, no chat data. Using QUAD to build/profile the
NPU bundle does not reintroduce a cloud dependency at demo time. GenieX itself runs and serves
fully locally as well. The **Telegram transport caveat from [FEASIBILITY.md](FEASIBILITY.md) is
still open and unrelated to this hardware plan** — messages relay through Telegram's servers
regardless of how the LLM runs, so the "no cloud hop / air-gapped" pitch language still needs
either softening or a real local-only transport swap. Not decided yet.

## Summary of what changed from the original pitch
- Ollama → GenieX (only path with genuine Hexagon NPU acceleration today)
- Phi-4-mini → Qwen3-4B-Instruct (confirmed tool-calling reliability + NPU bundle availability)
- No shim needed (GenieX is natively OpenAI-compatible)
- UNO Q: bonus, backs one real tool, not a dependency
- S25+: Telegram baseline + on-phone inference as an explicit stretch goal
- Data: hybrid — one real source, rest mocked
- Tool categories generalized: network/storage/server/environmental, not CI/CD-specific
- Arduino UNO Q reassigned from storage-capacity (not a real sensor use case) to
  environmental/physical monitoring (a genuine, demo-triggerable DCIM use case)
- Added proactive/push alerting via Hermes Agent's existing cron + Telegram gateway, doubling as a
  self-improvement demo beat
