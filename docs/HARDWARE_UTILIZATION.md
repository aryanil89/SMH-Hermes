# Hardware Utilization Plan

Available hardware: a Snapdragon X Elite Copilot+ PC, a Samsung Galaxy S25+ (Snapdragon 8 Elite
for Galaxy), an Arduino UNO Q (Qualcomm QRB2210), and the QUAD-Client SDK already set up locally
at `QUAD-Client-main/`. This replaces the earlier Ollama/Foundry-Local guess with what's actually
available and confirmed working.

## Snapdragon X Elite laptop — inference host (primary)
QUAD's `windows-x-elite` target (Hexagon V75, QNN 2.x) is its most-tested platform. This is where
Hermes Agent, the MCP tool servers, and the LLM all run.

- **Model**: Qualcomm's own on-device LLM runtime (GenieX) has confirmed NPU support for
  **Phi-3.5-mini-instruct**. Phi-4-mini is not in QUAD's or AI Hub's precompiled bundle catalog —
  GenieX can still load it as a raw GGUF from Hugging Face, but that's the unoptimized fallback
  path, not the tuned NPU bundle path. **Recommendation: build the pitch around Phi-3.5-mini-
  instruct as the primary NPU-accelerated model**, and keep Phi-4-mini-via-GGUF as a fallback/
  comparison point in the benchmark slide rather than the headline claim.
- **Pipeline**: use QUAD's existing skills — `quad-detect` → `quad-npu-prereqs` →
  `quad-recommend`/`aihub_select` → `quad-build-npu-bundle` (or `quad-convert` +
  `quad-executorch` for a custom ONNX/PyTorch path) → `quad-deploy` → `quad-serve`.
- **Integration gap to close**: `quad serve` exposes a custom `/infer` JSON API, not an
  OpenAI-compatible `/v1/chat/completions` endpoint, and Hermes Agent's custom-provider config
  expects the latter. **Action item: write a small local shim (FastAPI or Node) that translates
  Hermes Agent's OpenAI-style chat requests into `quad serve`'s `/infer` calls.** This is a
  half-day task, not a redesign — flagged explicitly so it's scheduled (fits Day 1, alongside the
  NPU bundle build itself).
- **Benchmarking**: `quad-profile` (latency P50/P95/P99, throughput, power) and `quad-orchestrate`
  (NPU/GPU/CPU allocation % and fallback ops across power modes) directly cover the "on-device vs.
  cloud baseline" benchmark slide from the 5-day plan — use real profiling data here instead of
  hand-waving it.

## Samsung Galaxy S25+ — mobile remote terminal
Matches QUAD's `android-8elite` target exactly (same Snapdragon 8 Elite family, just phone-form).
Two options, not mutually exclusive:
1. **As originally pitched**: just the phone running Telegram, talking to the PC-hosted agent.
   Simplest, fastest, keeps Day 3 scope as planned.
2. **Stretch goal**: since the phone is QUAD-compatible too, a second on-device NPU inference
   instance on the phone itself would make for a strong demo beat — "the same agent runs on both
   devices" — and gives a second, independent data point for the NPU benchmark comparison. Only
   attempt this if Days 1-3 land early; treat as Day 4-5 polish, not a dependency.

## Arduino UNO Q — physical infra tool, not an inference host
At 1 TOPS / 2GB RAM / INT8-only, it cannot run Phi-3.5-mini or any comparable LLM — don't spend
time trying. Its actual value here: it's a genuine physical device that can back one of the
pitch's MCP tools with real data instead of a mock. Recommendation — wire it as a live
"storage/telemetry" or "infra topology" node (e.g. a real sensor or a simulated rack-health
signal) that one of the MCP tools queries over the local network, driven via QUAD's `quad-unoq`
skill (SSH/ADB deploy). This turns "wired tools include storage capacity and risk state..." from
entirely simulated into partially real, which is a genuine differentiator for judges.

## Cloud-dependency check (updated)
QUAD's own remote MCP server (`quad.infra.foundries.io`) is *build-time only* — model conversion,
profiling, and codegen. It has no NPU and does not touch runtime inference or chat data. Using
QUAD to build the NPU bundle does **not** reintroduce a cloud dependency at demo/runtime — the
"no cloud LLM calls" claim from [FEASIBILITY.md](FEASIBILITY.md) still holds. The Telegram
transport caveat from that doc is unchanged and still needs the same decision (soften the
"air-gapped" language, or replace the transport) independent of this hardware plan.

## Net changes vs. the original FEASIBILITY.md recommendation
- Drop Foundry Local / Nexa SDK — QUAD + GenieX already does this, and it's the tool the user has
  already set up and knows.
- Swap headline model from Phi-4-mini to **Phi-3.5-mini-instruct** (confirmed NPU-supported).
- Add one concrete new task: the `quad serve` → OpenAI-compatible shim.
- Add the UNO Q as a real (if small) physical prop for one MCP tool instead of an inference target.
