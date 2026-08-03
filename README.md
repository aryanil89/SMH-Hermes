# SMH-Hermes
Project Hermes developed for Snapdragon Multiverse Hackathon 2026

On-device, self-improving AI agent for infrastructure operations. Runs [Hermes Agent](https://github.com/nousresearch/hermes-agent)
+ an NPU-accelerated LLM entirely on a Snapdragon X Elite Copilot+ PC, wired to live infra tools
via MCP, reachable from a phone over a messaging gateway.

## Docs
- [Requirements](docs/REQUIREMENTS.md) — what we're building and why
- [Feasibility analysis](docs/FEASIBILITY.md) — reality check against the pitch's technical claims
- [Hardware utilization plan](docs/HARDWARE_UTILIZATION.md) — how the Snapdragon X Elite laptop,
  Samsung Galaxy S25+, Arduino UNO Q, and the QUAD SDK are each actually used

## Layout
- `shim/` — Python/FastAPI adapter exposing an OpenAI-compatible endpoint over QUAD's `quad serve` NPU inference server
- `mcp-tools/` — MCP servers (TypeScript) wiring storage, CI/CD, dependency-graph, and infra-topology data into the agent
- `uno-q/` — Arduino UNO Q deployment config, driven via QUAD's `quad-unoq` skill, backing one live infra-tool with real hardware
