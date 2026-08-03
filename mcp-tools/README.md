# mcp-tools

MCP servers (TypeScript, via the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk))
that give Hermes Agent structured access to infrastructure data:

| Tool | Data source |
|---|---|
| Storage capacity / risk state | **Real** — Arduino UNO Q telemetry, see [../uno-q](../uno-q) |
| CI/CD pipeline health | Mocked |
| Code dependency graph | Mocked |
| Infrastructure topology | Mocked |

See [../docs/HARDWARE_UTILIZATION.md](../docs/HARDWARE_UTILIZATION.md) for the rationale on the
mock/real split.

**Not yet implemented** — Day 2 scope.
