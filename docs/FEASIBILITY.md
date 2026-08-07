# Feasibility Analysis

> **Historical (early Aug 2026, pre-build), kept for the decision trail.** The two inaccurate
> pitch claims called out below **were fixed before submission** — the approved current wording
> lives in [POSITIONING.md](POSITIONING.md) and the README. Where this page and the README
> disagree, **the README is current**.

Researched against current (Aug 2026) state of each dependency. Verdict: **mostly achievable**,
but two claims in the original pitch are not accurate as literally written and should be fixed
before the pitch is presented to an audience, not discovered on stage.

## Component-by-component

### Hermes Agent (Nous Research) — ✅ real, fits
Confirmed: MIT-licensed, self-improving agent with a built-in learning loop (skills created and
refined from experience, FTS5 session search), native MCP client, and a multi-platform gateway
that includes Telegram out of the box. It also accepts a custom OpenAI-compatible endpoint —
which is exactly what a local Ollama/Foundry server exposes, so wiring it to a fully local model
is a supported, documented path, not a hack.

**Risk — Windows on ARM**: ~~the official native Windows installer builds an `x64.exe` (NSIS).
There is no confirmed native Windows-ARM64 build. The documented Windows path Nous itself
recommends is WSL2.~~

> **RESOLVED / OUTDATED as of 2026-08-03** — this was the plan's #1 risk and it no longer applies.
> Nous's platform-support doc lists Windows 10/11 **aarch64 as Tier 1**, `install.ps1` has dedicated
> native-ARM64 logic, and the native Windows guide (added ~2026-05-08) is now the primary path with
> WSL2 as an alternative. See [AUDIT_2026-08-03.md](AUDIT_2026-08-03.md) §2.2. **Hermes runs native
> on Windows ARM64.** One consequence worth recording: had we stayed on WSL2, GenieX's
> `127.0.0.1:18181` would **not** have been reachable from inside the WSL2 VM without mirrored
> networking or the Windows host IP — a cross-boundary problem the native path avoids entirely.
> Current risk in this area is not the platform but installer churn: Hermes's Node 26 requirement
> landed 2026-08-02, so pin whatever the installer produces and don't upgrade mid-week.

### Phi-4-mini (Microsoft) — ✅ real, fits
MIT-licensed, 3.8B params, genuinely small enough for on-device use. No issues here.

### "Ollama ... QNN-accelerated on the Snapdragon NPU" — ❌ not achievable as stated
This is the central technical claim of the pitch, and it does not hold up:
- Ollama does have native Windows-ARM64 support today, but it is **CPU-only** — no NPU backend,
  no GPU (DirectML) backend for ARM64.
- llama.cpp's QNN/Hexagon-NPU backend (which Ollama would need) is still work-in-progress and,
  as of the most recent report found, doesn't yet implement `MUL_MAT` — the single most
  important op for LLM inference. It is not usable for real inference today.
  > **Partly superseded 2026-08-03**: the conclusion (don't use Ollama) stands, but this specific
  > reasoning is now too strong. GenieX ships a llama.cpp Hexagon backend that **does** offload real
  > inference — measured CPU load dropped to 12–17% with GGUF `Q4_0`. The catch is precision: `Q4_K_M`
  > silently falls back to CPU. See [NPU_SPIKE_RESULTS.md](NPU_SPIKE_RESULTS.md). The backend is
  > experimental, not absent.
- So "Hermes + Ollama + Phi-4 on the NPU" on Day 1 is not something that can actually be built —
  it would silently fall back to CPU, and the pitch's core differentiator (NPU-accelerated,
  not just "runs locally") would be false on stage.

> **Superseded — what was actually done**: neither Foundry Local nor Nexa was adopted. The final
> choice is **Qualcomm GenieX** serving `Qwen3-4B-Instruct-2507` GGUF `Q4_0`, and the Day-1 go/no-go
> spike below *was* run and passed. Read [NPU_SPIKE_RESULTS.md](NPU_SPIKE_RESULTS.md) and
> [HARDWARE_UTILIZATION.md](HARDWARE_UTILIZATION.md) for the outcome; the analysis below is retained
> as the reasoning that led there.

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
   scrutiny from outside reviewers.

Everything else in the pitch (Hermes Agent, Phi-4-mini, MCP tool wiring, the 5-day shape) is
accurate and achievable as described.
