# uno-q

Deployment config for the Arduino UNO Q, driven via QUAD's `quad-unoq` skill (SSH/ADB plumbing —
see `QUAD-Client-main/.claude/skills/quad-unoq/`).

The board (Qualcomm QRB2210, 1 TOPS, 2GB RAM, INT8-only) can't run an LLM — it backs one of the
MCP tools in [../mcp-tools](../mcp-tools) with real telemetry instead of mocked data. See
[../docs/HARDWARE_UTILIZATION.md](../docs/HARDWARE_UTILIZATION.md) for the reasoning.

**Not yet implemented** — which specific tool/signal it backs is still to be decided.
