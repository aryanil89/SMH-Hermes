# uno-q

Deployment config for the Arduino UNO Q, driven via QUAD's `quad-unoq` skill (SSH/ADB plumbing —
see `QUAD-Client-main/.claude/skills/quad-unoq/`).

Status: **bonus, not on the critical path**. The board (Qualcomm QRB2210, 1 TOPS, 2GB RAM,
INT8-only) can't run an LLM — it backs the storage-capacity/risk-state MCP tool in
[../mcp-tools](../mcp-tools) with real telemetry instead of mocked data. If this slips, that tool
falls back to real disk stats off the dev machine instead, with no loss to the core demo.

**Not yet implemented.**
