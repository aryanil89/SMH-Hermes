# uno-q

Deployment config for the Arduino UNO Q, driven via QUAD's `quad-unoq` skill (SSH/ADB plumbing —
see `QUAD-Client-main/.claude/skills/quad-unoq/`).

Status: **bonus, not on the critical path**. The board (Qualcomm QRB2210, 1 TOPS, 2GB RAM,
INT8-only) can't run an LLM — it backs the **environmental/physical-monitoring** MCP tool in
[../mcp-tools](../mcp-tools) with real sensor data (temperature, humidity, leak detection) instead
of mocked data. This is the board's genuine real-world use case — a real datacenter (DCIM) sensor
role, not a stand-in for a software metric like storage capacity — and it's physically triggerable
during a live demo. If this slips, the demo just drops this one tool with no loss to the core
pitch.

**Not yet implemented.**
