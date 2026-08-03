# Hermes — Requirements

> **Note**: this page records the *original pitch* as given. The finalized architecture
> (Ollama→GenieX, Phi-4-mini→Qwen3-4B, mock/real data split, hardware roles) is in
> [HARDWARE_UTILIZATION.md](HARDWARE_UTILIZATION.md) — read that for what's actually being built.

## Problem
Infrastructure on-call engineers need fast, contextual answers during incidents (dashboards, logs,
tickets) without sending operational data to the cloud or eating cloud-latency during an outage.

## Solution
An on-device, self-improving AI agent for infrastructure operations that runs entirely on a
Snapdragon X Elite Copilot+ PC's NPU. A Snapdragon mobile device acts as the remote terminal.

- **PC role**: runs the agent + LLM inference + persistent MCP tool connections (storage
  capacity/risk, CI/CD pipeline health, dependency graphs, infra topology).
- **Phone role**: mobility + voice/text input via a Telegram gateway; on-call engineer queries
  the agent while walking the datacenter floor; PC does the reasoning.

## Proposed components
| Component | Role |
|---|---|
| Hermes Agent (Nous Research, MIT) | Agent runtime: skills, memory, MCP client, messaging gateway |
| Ollama + Phi-4-mini (Microsoft, MIT) | Local LLM inference |
| QNN backend | NPU acceleration on Snapdragon |
| MCP TypeScript SDK | Tool wiring (storage, CI/CD, dependency graph, topology) |
| Telegram Bot API | Mobile gateway |

## 5-day plan (as proposed)
1. Hermes + Ollama + Phi-4 running on Snapdragon NPU
2. MCP tool connections wired and verified
3. Telegram gateway end-to-end from phone
4-5. Demo polish, latency benchmarks (on-device vs. cloud), incident scenario rehearsal

## Claimed properties
- No cloud API calls, no data exfiltration
- No cloud hop anywhere in the chain — local WiFi link only
- Operable in air-gapped / restricted-network environments

See [FEASIBILITY.md](FEASIBILITY.md) for a component-by-component reality check against these claims.
