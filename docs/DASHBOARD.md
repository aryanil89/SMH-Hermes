# The live operations wall

A single local web page that shows the whole demo happening: the UNO Q reporting
its environmental state, that feed arriving at the server, the other telemetry
families arriving alongside it, the inference drawn from all of them, and the
Telegram thread on the on-call phone.

It runs on the demo laptop and is displayed in that laptop's own browser. All
traffic is loopback; nothing about the page needs the network.

```
┌──────────────────┐   sensor    ┌───────────────────────────┐  telegram  ┌───────────┐
│  Arduino UNO Q   │ ─ feed ───▶ │  Server (Snapdragon)      │ ─ relay ─▶ │  Phone    │
│  door / lighting │             │  ingest → assess → alert  │ ◀───────── │  Telegram │
│  leak / temp/RH  │             │  network storage compute  │            │           │
└──────────────────┘             └───────────────────────────┘            └───────────┘
     left column                        middle column                      right column
```

## Run it

```powershell
cd mcp-tools
npm install; npm run build          # once
npm run start:dashboard             # then open http://127.0.0.1:7788
```

From a macOS/Linux dev machine the commands are identical.

**Worked when:** the page paints within a second or two, the header shows a
climbing tick counter, the `live` dot next to it is green, and the left column's
"Sensor log" pane grows a new `climate tick` line every ~10s.

If the header pill reads **"Sensor feed down · environmental reading is mock"**,
the display is working and telling you the truth: the sensor path is not
delivering. The Ingest card gives the reason string verbatim. Fix it the same way
you would for the agent — see the sensor-log rows in the README's troubleshooting
table (usually the board clock, step 2 ⚠️).

### Environment

| Variable | Default | What it does |
|---|---|---|
| `DASHBOARD_PORT` | `7788` | Listen port |
| `DASHBOARD_HOST` | `127.0.0.1` | Bind address. See the security note below |
| `DASHBOARD_TICK_MS` | `2000` | Snapshot cadence, floored at 250ms |
| `UNOQ_SENSOR_LOG` | repo-root `arduino_uno_q-sensor_log.json` | The sensor log to read |
| `UNOQ_LOG_MAX_AGE_S` | `3600` | Older than this and the feed counts as down. Set it to `180` to match the demo config |
| `ALERT_STATE_PATH` | `mcp-tools/.state/environmental-watch.json` | The watchdog state file the phone panel mirrors |
| `TELEGRAM_BOT_LABEL` | `Hermes Ops` | Name shown on the phone panel |
| `TELEGRAM_CHAT_TITLE` | `On-call · Telegram` | Subtitle under it |
| `SIM_WORLD_WINDOW_S` | `60` | How long the simulated families hold still — shared with the MCP tools |
| `HERMES_MODEL` / `HERMES_ACCELERATOR` | Qwen3-4B / Hexagon NPU | Header captions only — the page never talks to the model |

Set `UNOQ_LOG_MAX_AGE_S` the same way in both places. If the MCP server uses
`180` and the dashboard uses the `3600` default, the agent will fall back to mock
while the wall still shows a live feed, and the two will contradict each other.

### Endpoints

| Route | Purpose |
|---|---|
| `GET /` | The page |
| `GET /api/stream` | Server-sent events: one full snapshot per tick |
| `GET /api/state` | The same snapshot as plain JSON, for scripting or a screenshot |
| `GET /api/health` | Liveness, tick count, connected browsers, feed state |
| `POST /api/telegram` | Feed a real gateway message onto the phone panel (below) |

## What each panel is reading

Nothing on this page is generated for the display. Every value comes from the
same function an MCP tool calls, with the same inputs, so the wall and the agent
cannot disagree.

| Panel | Source | Real or simulated |
|---|---|---|
| Temperature, humidity, leak, reading age, `source` badge | `getEnvironmentalReading()` — the exact call behind `get_environmental_status` | **Real** when the board is delivering; mock fallback otherwise, always labelled |
| Door, lighting, presence state | Derived by the dashboard from the paired button edges in the sensor log | **Real** |
| Climate sparklines & readings table | The sensor log's recent lines | **Real** (may be stale — see below) |
| Ingest card | The log file itself: size, line count, newest timestamp, freshness gate | **Real** |
| Signal sources grid | `generateNetworkReport` / `generateStorageReport` / `generateComputeReport` | **Simulated**, each card says so |
| Risk score, confidence, evidence, cause, action | `assessIncident()` — the exact call behind `get_incident_assessment` | Rule-derived from the above |
| Telegram thread | The watchdog's state file, plus anything posted to `/api/telegram` | **Real** — see the honesty rules below |

### Door, lighting and presence

The environmental MCP tool answers "what is it now?" and returns temperature,
humidity and leak. It does not carry door or lighting state, so the dashboard
derives those itself from the log's paired button edges (`door_open` /
`door_closed`, `light_on` / `light_off`, `object_entered` / `object_left`),
newest edge wins.

A channel with **no edge anywhere in the log window reads `unknown`, not
"closed"**. This is not hypothetical: the board only learned to emit release
events partway through the build, so older logs contain `light_on` with no
matching `light_off`. Rendering an unobserved door as "secure" would be the
display inventing a fact.

### Why the trend can disagree with the number

The big temperature figure comes from the environmental tool, which substitutes
mock data when the log is unusable. The sparkline under it always comes from the
log. When the tool has fallen back to mock, those two are different sources, so
the page dims the trace, captions it "last logged trend · N old", and adds
"value above is mock". They are not one measurement and are not drawn as one.

### The world holds still for 60 seconds

The simulated families seed their PRNG from a 60-second time bucket
(`common/rng.ts`), so their numbers are stable within a window and then advance.
That is why the device grid does not jitter every 2s, and why the "telemetry
polled" lines in the processing stream appear once a minute rather than every
tick — emitting a poll event per tick would imply a data rate that isn't there.

The dashboard captures the seed **once per tick** and passes it to the assessment
and to all three family reports, so a tick landing on a bucket boundary can't
show an assessment built from one world beside a device grid from the next.

## The phone panel's honesty rules

The panel must never claim a delivery that has not happened. Three things can put
a message on it, and each bubble says which:

1. **`watchdog · sent`** — the cron job's state file changed, which only happens
   when a tick actually decided to send. Evidence of a real delivery, observed
   after the fact. A threshold alert bumps `lastAlertedAt`; a recovery clears it
   and drops `lastStatus` to `ok`, so recovery is detected from the status
   transition instead.
2. **`queued · next watchdog tick`** — running the *same* `decideAlert` the cron
   job runs says an alert is due right now. The watchdog fires every 5 minutes,
   so the wall knows before the phone does. Rendered greyed, dashed and explicitly
   labelled. When the watchdog then fires, that exact queued text is promoted to
   a delivered bubble.
3. **`gateway · sent`** — posted in over `POST /api/telegram`, verbatim, either
   direction.

The alternative — letting the dashboard run its own alert loop against its own
state file — would produce a plausible message stream that no phone ever
received. Mirroring the real state file keeps the panel accountable.

Both the watchdog and the dashboard build their alert text from
`src/alert-skill/summarize.ts`, so the wording on the wall is the wording on the
phone, character for character.

### Showing real phone traffic

The watchdog path is real but it is only the proactive half. To put genuine
question-and-answer traffic on the panel, post it in:

```powershell
curl.exe -X POST http://127.0.0.1:7788/api/telegram `
  -H "content-type: application/json" `
  -d '{\"direction\":\"inbound\",\"text\":\"what is the temperature in rack B1?\"}'
```

`direction` is `inbound` (phone → server) or `outbound` (server → phone); `text`
is required; `kind` and `at` are optional. Anything ingested is marked
`gateway · sent` and pushes a frame immediately rather than waiting for the next
tick. Hermes does not post to this endpoint on its own — wiring the gateway to it
is a small integration that has not been built.

## Design notes

- **Dark only, on purpose.** One deployment: a browser left open on the demo
  laptop, usually in a dim room. The chart colours are the dark steps of a
  palette validated against this page's surface — categorical slots 1 and 3 for
  the two climate series, and a fixed status palette for good/warning/critical
  that is never reused for a series.
- **No meaning rests on colour alone.** Every status carries an icon and a word.
- **No build step and no dependencies.** `public/` is plain HTML, CSS and one ES
  module, served straight from disk. Nothing to compile, nothing to fetch from a
  CDN, so the page works with the WiFi off — which is the whole point of the
  demo.
- **Rendering is a keyed diff, not `innerHTML`.** At a 2s cadence a wholesale
  rewrite would reset scroll position in the two log panes, restart every enter
  animation, and drop a tooltip the moment anyone hovered a chart.
- **Every chart has a table view.** "Readings table" under the climate charts is
  the WCAG-clean twin; the tooltip enhances, it never gates a value.
- **Reduced motion is respected.** The flowing conduits become static dots under
  `prefers-reduced-motion: reduce`.
- **Browser support:** Chromium-based Edge and Chrome (the demo laptop), plus
  Safari and Firefox. Uses `color-mix()`, `writing-mode`, CSS grid and
  `EventSource` — all baseline in current Edge. Below 1080px wide the three
  columns stack and the conduits turn horizontal.

## Security

Loopback bind, no authentication, no state a restart would miss. This is a
demo-table display for the browser on the same machine, **not a service**.
`DASHBOARD_HOST=0.0.0.0` exists for a laptop-plus-tablet demo table and nothing
else — on venue WiFi it would expose the sensor log, the file paths and the
Telegram text to anyone on the network. The static file handler is containment-
checked against `public/` and the ingest endpoint caps bodies at 16KB, but those
are hygiene, not a security posture.

## Layout

```
mcp-tools/
  public/                      the page — no build step
    index.html                 shell + icon sprite
    styles.css                 dark theme, validated palette
    app.js                     SSE client, keyed diff renderer, sparklines
  src/dashboard/
    server.ts                  HTTP + SSE + static + ingest
    snapshot.ts                assembles one frame from the same calls the tools make
    sensor-log.ts              tail the log; derive channels, trend, event feed
    telegram-feed.ts           the phone panel's three message sources
    types.ts                   the wire contract
```
