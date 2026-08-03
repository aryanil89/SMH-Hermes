# SMH-Hermes
Project Hermes developed for Snapdragon Multiverse Hackathon 2026

On-device, self-improving AI agent for infrastructure operations. Runs [Hermes Agent](https://github.com/nousresearch/hermes-agent)
+ Qwen3-4B-Instruct, NPU-accelerated via Qualcomm GenieX, entirely on a Snapdragon X Elite
Copilot+ PC, wired to infra tools via MCP, reachable from a Samsung Galaxy S25+ over Telegram.

## Docs
- [Requirements](docs/REQUIREMENTS.md) — the original pitch (see the note at the top — architecture has since changed)
- [Feasibility analysis](docs/FEASIBILITY.md) — reality check against the pitch's technical claims
- [Hardware utilization plan](docs/HARDWARE_UTILIZATION.md) — **the finalized architecture**: where
  the LLM runs, which model, and how the Snapdragon X Elite laptop, Samsung Galaxy S25+, Arduino
  UNO Q, and the QUAD SDK are each actually used

## Layout
- `mcp-tools/` — MCP servers (TypeScript) wiring network/storage/server (mocked) and environmental/physical (real, via UNO Q) datacenter health data into the agent, plus a proactive-alert cron skill
- `uno-q/` — Arduino UNO Q deployment config, driven via QUAD's `quad-unoq` skill, backing the environmental/physical-monitoring tool with real sensor data (bonus, not on the critical path)
- `phone/` — Samsung Galaxy S25+ stretch goal: second on-device GenieX/Qwen3-4B instance for a two-device demo beat
