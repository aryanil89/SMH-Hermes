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
| `ACCESS_STATE_PATH` | `mcp-tools/.state/access.json` | Open challenge + the access audit trail |
| `ACCESS_ROSTER_PATH` | `mcp-tools/.state/roster.json` | Enrolled people. **Embeddings only, never images** |
| `ACCESS_IDENTITY_METHOD` | `stub` | Identity rung: `stub` \| `qr-badge` \| `face-npu` \| `face-cpu` |
| `ACCESS_MATCH_THRESHOLD` | `0.5` | Cosine similarity for a face match. **A starting point, not a calibrated value** — tune it against the actual enrolled faces and record what you measured |
| `ACCESS_DOOR_LOOKBACK_MS` | `30000` | How far *before* a presence edge a door-open still counts as the same entry. Too short and a normal badge-in reads as tailgating |
| `ACCESS_VISION_SCRIPT` / `ACCESS_PYTHON` | unset / `python` | The face pipeline, for rungs 1–2 |
| `ACCESS_SUPPRESS_MAX_AGE_S` | `180` | Older than this and the access state cannot withhold a page — see below |
| `ACCESS_SHARED_SECRET` | unset | Required as `x-access-secret` on the three write routes. **Set this whenever `DASHBOARD_HOST` is not loopback** |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | unset | Optional access notification. Silent no-op when unset |

Set `UNOQ_LOG_MAX_AGE_S` the same way in both places. If the MCP server uses
`180` and the dashboard uses the `3600` default, the agent will fall back to mock
while the wall still shows a live feed, and the two will contradict each other.

### Endpoints

| Route | Purpose |
|---|---|
| `GET /` | The wall |
| `GET /phone.html` | The access terminal — the phone view (see [../phone/README.md](../phone/README.md)) |
| `GET /api/stream` | Server-sent events: one full snapshot per tick |
| `GET /api/state` | The same snapshot as plain JSON, for scripting or a screenshot |
| `GET /api/health` | Liveness, tick count, connected browsers, feed state |
| `POST /api/telegram` | Feed a real gateway message onto the phone panel (below) |
| `GET /api/access/state` | The access slice alone, for a reconnecting phone |
| `POST /api/access/capture` | `{imageBase64?, badges?}` → identify → verdict |
| `POST /api/access/approve` | `{id, decision, decidedBy}` — authorise or refuse a challenge |
| `POST /api/access/enroll` | `{name, embedding, method}` — add to the roster |

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
| Access card | `AccessSentry.update()` — the same object the phone terminal talks to | **Real** decision over real presence/door edges; identity depends on the configured rung |

### Access — who is at the rack

The Access card sits directly under the door/presence tiles because it is derived
from them. Until it existed, those two channels were only ever *drawn*: the board
had been reporting `door_open` and `object_entered` for days and nothing read them
for meaning.

The verdict is one label — the worst thing true — with every contributing reason
kept alongside it, so picking a headline never discards what else was observed:

| Verdict | When |
|---|---|
| `idle` | nobody at the rack |
| `pending-capture` | presence detected, no capture yet. Warning once the 60s grace lapses — **an unanswered challenge is itself the finding** |
| `clear` | known person, ordinary conditions |
| `expected` | known person **during a live incident** — the on-call responding. The only verdict that makes the system quieter |
| `challenge` | unknown person → approval required |
| `unauthorized-during-incident` | unknown person while something is already wrong. Worse than either alone |
| `anti-passback` | at the rack with no door-open edge in this episode |
| `tailgating` | more faces than authorised entries — the canonical datacenter breach |

Three things the card refuses to do:

- **An unobserved door is not a closed door.** `doorConsistent` is true, false, or
  absent — three states, same rule the channel tiles already follow.
- **A decision does not rewrite the finding.** Approving a tailgating event relaxes
  the severity to `ok` and records who allowed it; the verdict still reads
  `tailgating`. Denial does *not* quiet the alarm — a refused stranger still
  standing at the rack is not a resolved situation.
- **One visit is one record.** The challenge stays open until presence ends, then
  files itself once. An earlier build retired it on approval, which freed the slot
  and re-challenged the same person on the next tick — approving a judge and then
  accusing them two seconds later.

Identity comes from a swappable rung (`ACCESS_IDENTITY_METHOD`); the default is
detection-only, so an unconfigured machine reports everyone as unknown rather than
claiming a match it never made. Full ladder in [../phone/README.md](../phone/README.md).

**Nothing on this path stores an image.** Captures are resolved to an embedding and
dropped; `mcp-tools/.state/roster.json` holds floats only.

### `expected` withholds a page — how that actually works

This is the one rule that makes the system quieter, so it is worth stating exactly.

When the verdict is `expected` — a person **on the roster**, present while an
incident is live — the watchdog withholds the page. The chain is
`check-environmental.js` → `alert-skill/suppress.ts` → `access/decide.ts`, reading
`.state/access.json` across a process boundary. **One writer per file:** the
dashboard drives the sentry and owns `access.json`; the cron process only reads it.

Three properties, in the order they matter:

1. **Held, not cancelled.** While a page is held, `lastStatus` is deliberately
   *not* advanced, so the crossing is still un-notified and fires the moment the
   responder leaves — annotated *"held while the on-call was on site; sending
   now"*. Advancing it would hand the alert to the one-hour cooldown and lose it.
2. **Escalation always wins.** The baseline is the status **when the hold began**,
   carried on `heldPage.heldStatus` — not the last status paged at. That
   distinction is load-bearing: on a cold start the last paged status is `ok`, so
   using it made *every* first alert an escalation and suppression never engaged
   at all. You know about the situation you walked into; you do not know about
   anything that got worse afterwards.
3. **Fail open.** Suppression depends on the *dashboard* being alive to write
   `access.json`. If the wall is down that file goes stale, and past
   `ACCESS_SUPPRESS_MAX_AGE_S` the watchdog pages regardless. A watchdog silenced
   by a dead input is indistinguishable from one silenced by good news.

Demo beat: **stand at the rack and it stays quiet; walk away and the page arrives.**

### When the feed goes stale

The board dying is not the same event as a person leaving. If the sensor log is
stale or unreadable, the sentry **freezes** — the open challenge stays open, no
abandonment is filed, and severity reads `warning` with "presence unobservable".

Without that gate a dead cable filed *"presence ended with no decision"*: a record
of a human decision nobody was ever asked for. An audit trail that invents entries
is worse than none.

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
  `EventSource` — all baseline in current Edge. Below 940px wide the three
  columns stack and the conduits turn horizontal.

## Security

**The read paths are a display; the write paths are an access-control system.**
`/api/access/enroll` is the sharpest edge — the roster is what every later
decision trusts, so anyone who can reach the port could add themselves and then
badge in as `known`. Set **`ACCESS_SHARED_SECRET`** whenever `DASHBOARD_HOST` is
anything other than loopback; the three write routes then require it as
`x-access-secret` (constant-time compared), and the phone picks it up from
`?secret=…` in the URL. The server prints a warning at startup if you bind to a
network without one.

It is opt-in and unset by default on purpose: a judge must be able to clone and
run this from the README, and a mandatory secret turns that into a support ticket.
It is also one lock on one door, not an auth system — say that rather than
implying more.

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
  public/                      the pages — no build step
    index.html                 wall shell + icon sprite
    styles.css                 dark theme, validated palette
    app.js                     SSE client, keyed diff renderer, sparklines
    phone.html                 the access terminal — self-contained, one file
  src/dashboard/
    server.ts                  HTTP + SSE + static + ingest + access routes
    snapshot.ts                assembles one frame from the same calls the tools make
    sensor-log.ts              tail the log; derive channels, trend, event feed
    telegram-feed.ts           the phone panel's three message sources
    types.ts                   the wire contract
  src/access/
    decide.ts                  the access decision matrix — pure, table-testable
    sentry.ts                  drives the loop: presence in, verdict out, approval recorded
    identify.ts                the identity ladder (NPU / CPU / detect-only / QR badge)
    roster.ts                  enrolled embeddings + cosine matching. Never images
    state.ts                   open challenge + append-only audit trail (atomic writes)
    notify.ts                  fire-and-forget challenge push. Never awaited from a tick
    types.ts                   access event shape
  src/alert-skill/
    suppress.ts                the bridge that lets `expected` actually withhold a page
```

`phone.html` is deliberately one self-contained file rather than sharing the
wall's `app.js`. It is opened at a rack, on a phone, possibly on a hotspot with
no internet — the worst possible place to discover a missing stylesheet.
