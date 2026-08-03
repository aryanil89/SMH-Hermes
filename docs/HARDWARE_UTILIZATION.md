# Hardware Utilization Plan

Available hardware: a Snapdragon X Elite Copilot+ PC, a Samsung Galaxy S25+ (Snapdragon 8 Elite
for Galaxy), an Arduino UNO Q (Qualcomm QRB2210), and the QUAD-Client SDK already set up locally
at `QUAD-Client-main/`. Finalized architecture below, superseding earlier drafts.

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
- **QUAD-Client's role** narrows to what it's actually for: `quad-detect` (hardware/NPU
  prerequisites), `quad-convert`/`quad-build-npu-bundle` (if a custom bundle is needed instead of
  a prebuilt one), and `quad-profile`/`quad-orchestrate` for the Day 4-5 latency/power benchmark
  (NPU vs CPU comparison, using real profiling data). It is not the serving layer.
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
Included as a bonus per decision: it backs the **storage-capacity/risk-state** MCP tool with real
hardware telemetry instead of mocked data, driven via QUAD's `quad-unoq` skill (SSH/ADB deploy).
Not on the critical path — if it slips, that tool falls back to the same synthetic-data approach
as the others with no loss to the core demo.

## MCP tool data strategy (hybrid, per decision)

| Tool | Data source |
|---|---|
| Storage capacity / risk state | **Real** — Arduino UNO Q telemetry (or real disk stats off the dev machine if the UNO Q integration slips) |
| CI/CD pipeline health | Mocked — believable synthetic build/pipeline data |
| Code dependency graph | Mocked — synthetic but structurally realistic graph |
| Infrastructure topology | Mocked — synthetic topology data |

Rationale: wiring real CI/CD, dependency-graph, and topology data sources is integration work
with no guaranteed payoff in a 5-day window and real risk of breaking live during a demo. One
real, physically-tangible data source (the UNO Q) is enough to make the "not everything is
mocked" point to judges without betting the whole demo on live infra integrations.

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
- Data: hybrid — one real source (storage/UNO Q), rest mocked
