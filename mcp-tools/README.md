# mcp-tools

MCP servers (TypeScript, via the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk))
that give Hermes Agent structured access to datacenter health data — general infrastructure
categories, not tied to any specific tool like CI/CD:

| Category | Data source |
|---|---|
| Network | Mocked |
| Storage | Mocked |
| Server / compute | Mocked |
| Environmental / physical | **Real** — Arduino UNO Q sensor, see [../uno-q](../uno-q) |

Alongside the pull-based tools above, a cron-triggered Hermes skill watches one of them and
proactively pushes a Telegram alert when a threshold is crossed — see
[Proactive alerting](../docs/HARDWARE_UTILIZATION.md#proactive-alerting).

See [../docs/HARDWARE_UTILIZATION.md](../docs/HARDWARE_UTILIZATION.md) for the rationale on the
mock/real split.

**Not yet implemented** — Day 2 scope.
