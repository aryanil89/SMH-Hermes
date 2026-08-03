# Feasibility Analysis

Researched against current (Aug 2026) state of each dependency. Verdict: **mostly achievable**,
but two claims in the original pitch are not accurate as literally written and should be fixed
before the pitch is presented to judges, not discovered on stage.

## Component-by-component

### Hermes Agent (Nous Research) — ✅ real, fits
Confirmed: MIT-licensed, self-improving agent with a built-in learning loop (skills created and
refined from experience, FTS5 session search), native MCP client, and a multi-platform gateway
that includes Telegram out of the box. It also accepts a custom OpenAI-compatible endpoint —
which is exactly what a local Ollama/Foundry server exposes, so wiring it to a fully local model
is a supported, documented path, not a hack.

**Risk — Windows on ARM**: the official native Windows installer builds an `x64.exe` (NSIS).
There is no confirmed native Windows-ARM64 build. The documented Windows path Nous itself
recommends is WSL2. WSL2 on an ARM64 Windows host runs an ARM64 Linux kernel, and both Node 22
and Python 3.11 (Hermes's runtime deps) ship arm64 Linux builds, so this should work — but it is
untested by us and must be the very first thing verified on Day 1, before anything else is built
on top of it.

### Phi-4-mini (Microsoft) — ✅ real, fits
MIT-licensed, 3.8B params, genuinely small enough for on-device use. No issues here.

### "Ollama ... QNN-accelerated on the Snapdragon NPU" — ❌ not achievable as stated
This is the central technical claim of the pitch, and it does not hold up:
- Ollama does have native Windows-ARM64 support today, but it is **CPU-only** — no NPU backend,
  no GPU (DirectML) backend for ARM64.
- llama.cpp's QNN/Hexagon-NPU backend (which Ollama would need) is still work-in-progress and,
  as of the most recent report found, doesn't yet implement `MUL_MAT` — the single most
  important op for LLM inference. It is not usable for real inference today.
- So "Hermes + Ollama + Phi-4 on the NPU" on Day 1 is not something that can actually be built —
  it would silently fall back to CPU, and the pitch's core differentiator (NPU-accelerated,
  not just "runs locally") would be false on stage.

**Fix**: swap Ollama for **Microsoft Foundry Local** (ONNX Runtime + QNN execution provider,
Microsoft's own Copilot+ PC NPU stack) or the **Nexa SDK**, both of which ship an NPU-quantized
Phi-4-mini variant for Snapdragon and both expose an OpenAI-compatible local endpoint — the same
integration point Hermes Agent already expects, so this is a low-cost swap, not a redesign.
Caveat: there are open bug reports of `phi-4-mini-reasoning-qnn-npu` failing to load in Foundry
Local on some Snapdragon devices. **Day 1 must include a go/no-go spike**: if the NPU path
doesn't load cleanly within a few hours, fall back to CPU inference via Ollama and keep "on
Snapdragon NPU" as a stretch goal to demonstrate in the Day 4-5 benchmark rather than a Day-1
dependency the rest of the week is built on.

### MCP TypeScript SDK — ✅ real, no issues
Standard, well-supported. Wiring storage/CI/CD/dependency-graph/topology tools through MCP
servers is Day-2 scope work, not a research risk.

### Telegram Bot API gateway — ⚠️ works, but contradicts the "no cloud hop" / "air-gapped" claims
Built into Hermes Agent already, so it's the fastest way to get a mobile client working — but
the Telegram Bot API is not a local socket. Every message is relayed through Telegram's own
servers (`api.telegram.org`) over the internet, even when phone and PC are on the same WiFi.
That means:
- "over a local WiFi link. No cloud hop anywhere in the chain" is **false** as stated — the
  *inference* is on-device and no data reaches an LLM cloud API, but the *message transport*
  itself does leave the building via Telegram's infrastructure.
- "operable in air-gapped or restricted-network environments" **directly conflicts** with using
  Telegram, which requires outbound internet access to function at all. An air-gapped datacenter
  by definition can't reach Telegram's servers.

**Fix — pick one**:
1. Keep Telegram for the demo (fastest, zero custom mobile app, matches the built-in connector)
   and soften the pitch language to "zero cloud LLM calls / data never leaves the device for
   inference" rather than "no cloud hop anywhere" or "air-gapped" — a narrower, still-impressive,
   and accurate claim.
2. If the air-gapped/local-only claim is load-bearing for judging, replace Telegram with a
   genuinely local transport (e.g. a small local HTTP/WebSocket endpoint on the PC that a
   phone browser or minimal PWA talks to directly over WiFi, no external relay). This is more
   work and would need to be scoped into the Day-3 slot instead of the built-in gateway.

## Overall verdict
Buildable in 5 days **with two amendments**:
1. Replace Ollama with Foundry Local (or Nexa SDK) for genuine NPU acceleration, with Ollama/CPU
   kept as the tested fallback if the NPU path misbehaves.
2. Either soften the "no cloud hop / air-gapped" claims to match what Telegram actually allows,
   or swap the mobile gateway for a real local-only transport if that claim must survive
   scrutiny from judges.

Everything else in the pitch (Hermes Agent, Phi-4-mini, MCP tool wiring, the 5-day shape) is
accurate and achievable as described.
