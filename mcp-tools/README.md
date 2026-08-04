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

Alongside the pull-based tools above, a Hermes cron job watches the environmental data every 5 min
and proactively pushes a Telegram alert when a threshold is crossed or recovers. It runs in
**`--no-agent` script mode** ([cron/environmental-watch.py](cron/environmental-watch.py)), so no LLM
runs on a tick and silence is the default — see
[Proactive alerting](../docs/HARDWARE_UTILIZATION.md#proactive-alerting) and, to test it end to end,
[../docs/E2E_TEST.md](../docs/E2E_TEST.md).

See [../docs/HARDWARE_UTILIZATION.md](../docs/HARDWARE_UTILIZATION.md) for the rationale on the
mock/real split.

## Status

**Built and unit-tested** (vitest suites alongside each module) as of 2026-08-03:

- Four stdio MCP servers in [src/servers/](src/servers/) — `network`, `storage`, `compute`,
  `environmental`. Build output lands in `dist/servers/*.js`, which is what Hermes launches.
- Realistic mocks for network/storage/compute: rack topology, degraded-link probabilities, and
  threshold logic in [src/common/thresholds.ts](src/common/thresholds.ts).
- Edge-triggered alert logic with cooldown and recovery —
  [src/alert-skill/decide-alert.ts](src/alert-skill/decide-alert.ts).
- The proactive watchdog: [cron/environmental-watch.py](cron/environmental-watch.py) (production,
  `--no-agent`) plus [skills/environmental-watch/](skills/environmental-watch/), retained for
  manual/agent-narrated runs only.

Run the tests with `npm test`.

### Environmental data: three sources, tried in order

[src/environmental/source.ts](src/environmental/source.ts) never throws and never hangs — it
degrades instead:

1. **Pushed sensor log** (preferred) — reads the JSON-lines file the board streams to this machine.
   Set `UNOQ_SENSOR_LOG`. No network round-trip at read time. Button A/B/C map to
   `door_open`/`light_on`/`leak_detected`, and a leak event counts as live for
   `UNOQ_LEAK_WINDOW_S` seconds (default 300) — so tripping button C on stage reads as a leak.
   Implementation: [src/environmental/file-source.ts](src/environmental/file-source.ts).
2. **SSH pull** — `UnoQClient.readSensors()` over SSH when `UNOQ_HOST` is set, bounded by
   `UNOQ_TIMEOUT_MS` (default 3000).
3. **Mock fallback** — a plausible reading with `fallbackReason` explaining what failed, so a demo
   never dies because a board is unplugged.

Configure with `UNOQ_SENSOR_LOG`, `UNOQ_HOST`, `UNOQ_USER`, `UNOQ_TIMEOUT_MS`,
`UNOQ_LEAK_WINDOW_S`, `UNOQ_LOG_MAX_AGE_S` (staleness guard, 180 in production — an older log
degrades to mock rather than reporting stale data as real) and `UNOQ_LEAK_DISTANCE_MM` (water-level
leak threshold; unset = level detection off, event-based leak still works). Background on the push
pipeline: [../uno-q/hermes-sensor-logger/README.md](../uno-q/hermes-sensor-logger/README.md).

**Wired into Hermes and verified end to end** (2026-08-03) — all four servers are registered in
`%LOCALAPPDATA%\hermes\config.yaml` and have been exercised over the NPU-served endpoint with real
tool calls. See [../PROGRESS.md](../PROGRESS.md) NEXT item 3.
