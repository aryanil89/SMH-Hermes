# mcp-tools

MCP servers (TypeScript, via the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk))
that give Hermes Agent structured access to datacenter health data — general infrastructure
categories, not tied to any specific tool like CI/CD:

| Category | Data source |
|---|---|
| Network | Simulated — **deliberately uncoupled** from temperature (the control family) |
| Storage | Simulated, **thermally coupled** to the real rack temperature |
| Server / compute | Simulated, throttles above the real onset temperature |
| Environmental / physical | **Real** — Arduino UNO Q sensor, see [../uno-q](../uno-q) |
| **Incident assessment** | Derived — correlates all four into one verdict (risk + confidence + evidence) |

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

- Five stdio MCP servers in [src/servers/](src/servers/) — `network`, `storage`, `compute`,
  `environmental` and `assessment`. Build output lands in `dist/servers/*.js`, which is what
  Hermes launches.
- Realistic mocks for network/storage/compute: rack topology, degraded-link probabilities, and
  threshold logic in [src/common/thresholds.ts](src/common/thresholds.ts).
- Edge-triggered alert logic with cooldown and recovery —
  [src/alert-skill/decide-alert.ts](src/alert-skill/decide-alert.ts).
- The proactive watchdog: [cron/environmental-watch.py](cron/environmental-watch.py) (production,
  `--no-agent`) plus [skills/environmental-watch/](skills/environmental-watch/), retained for
  manual/agent-narrated runs only.

Run the tests with `npm test` (90 tests).

### Thermal coupling — why the correlation is real

The pitch is that Hermes *correlates* physical and digital signals. If the simulators drew
independent numbers, "temperature rose, then storage slowed" would be a coincidence the demo
manufactures — and it would not reproduce on a second run, which is exactly what a technical judge
will ask for.

So simulated telemetry is a **documented function of the real rack temperature**
([src/common/thermal.ts](src/common/thermal.ts)):

| Family | Coupling |
|---|---|
| Storage (`zone-east` only) | Read latency rises superlinearly above 26 °C; backup throughput falls ~3.5 %/°C; backup delay is arithmetic from the throughput deficit |
| Compute | Clock throttling engages at 34 °C, which reads as higher CPU for the same work |
| **Network** | **None, on purpose** — it takes no temperature input at all |
| Storage `zone-west` | **None** — same simulator, no heat: the second control |

The two uncoupled families are what make the diagnosis falsifiable. When the agent says *"cooling
degradation, network needs no action"*, it is discriminating between families that genuinely move
and families that genuinely don't. **Say this out loud on stage** — and do not add thermal coupling
to network, or the discriminating signal disappears.

### Incident assessment — one call, one verdict

`get_incident_assessment` ([src/assess/](src/assess/)) exists for a hard reason: every extra tool
call costs a full prompt re-prefill on the NPU (2–4 min), so a four-call answer is a ten-minute
answer. All arithmetic runs in TypeScript in microseconds; the model only relays `summary`.

- **Risk** — a 0–100 rule-based severity index, scored **per independent family** with
  within-family decay, so one root cause seen through three metrics doesn't score triple. Agreement
  across families earns a correlation bonus. It is **not** a probability.
- **Confidence** — **ordinal** (`none`/`low`/`medium`/`high`), driven by *provenance*, not severity.
  A percentage would imply a calibration we have no labelled incidents to support.
- **`confidence: none` whenever the physical reading is simulated.** On 2026-08-04 the watchdog
  pushed "CRITICAL, 38.95 °C" to the on-call phone while the board had been offline 10.7 hours. The
  reading was honestly labelled mock — but the *severity was unchanged* by every number in it being
  invented. A mock temperature is also never fed into the couplings, so it cannot fabricate a
  correlation either.
- **Severity floors** — a confirmed leak is critical on its own. Its cost is asymmetric enough that
  waiting for corroboration is itself the error, so it is categorical rather than additive.

### Environmental data: three sources, tried in order

[src/environmental/source.ts](src/environmental/source.ts) never throws and never hangs — it
degrades instead:

1. **Pushed sensor log** (preferred) — reads the JSON-lines file the board streams to this machine.
   Set `UNOQ_SENSOR_LOG`. No network round-trip at read time. Buttons log **both edges** — A/B/C map
   to `door_open`/`door_closed`, `light_on`/`light_off`, `leak_detected`/`leak_cleared` — and a leak
   event counts as live for `UNOQ_LEAK_WINDOW_S` seconds (default 300) *unless* a later
   `leak_cleared` cancels it, so holding button C on stage reads as a leak and releasing it
   recovers. Note `leak_cleared` also contains the substring `leak`: the scan checks for it
   explicitly **before** the substring test, or the clearing event would re-raise the alert.
   Implementation: [src/environmental/file-source.ts](src/environmental/file-source.ts).
2. **SSH pull** — `UnoQClient.readSensors()` over SSH when `UNOQ_HOST` is set, bounded by
   `UNOQ_TIMEOUT_MS` (default 3000).
3. **Mock fallback** — a plausible reading with `fallbackReason` explaining what failed, so a demo
   never dies because a board is unplugged.

Configure with `UNOQ_SENSOR_LOG`, `UNOQ_HOST`, `UNOQ_USER`, `UNOQ_TIMEOUT_MS`,
`UNOQ_LEAK_WINDOW_S`, `UNOQ_LOG_MAX_AGE_S` (staleness guard, 180 in production — an older log
degrades to mock rather than reporting stale data as real) and `UNOQ_LEAK_DISTANCE_MM` (water-level
leak threshold; unset = level detection off, event-based leak still works).

⚠️ `UNOQ_LEAK_DISTANCE_MM` is **currently inert even if set**: the board stopped putting
`distance_mm` on `sensor_tick` lines on 2026-08-05, and this reader takes distance from the newest
line — which is nearly always a tick. Distance now only arrives on presence/button lines. Restoring
level detection means putting `distance_mm` back on the tick, board-side.

Background on the push pipeline:
[../uno-q/hermes-sensor-logger/README.md](../uno-q/hermes-sensor-logger/README.md).

**Wired into Hermes and verified end to end** (2026-08-03) — all four servers are registered in
`%LOCALAPPDATA%\hermes\config.yaml` and have been exercised over the NPU-served endpoint with real
tool calls. See [../PROGRESS.md](../PROGRESS.md) NEXT item 3.
