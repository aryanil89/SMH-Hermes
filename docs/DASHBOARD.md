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
| `UNOQ_LOG_MAX_AGE_S` | `180` | Older than this and the feed counts as down. Matches the gateway's `config.yaml` and the Scheduled Task payloads; the wall imports the constant from `environmental/file-source.ts` so the two cannot drift |
| `ALERT_STATE_PATH` | `mcp-tools/.state/environmental-watch.json` | The watchdog state file the phone panel mirrors |
| `WATCH_HEALTH_PORT` | `7789` | Where the wall probes for a live watchdog loop. `0` disables the probe |
| `WATCH_HEALTH_CACHE_MS` | `5000` | How long a probe result is reused, so a 2s repaint is not a socket per tick |
| `TELEGRAM_BOT_LABEL` | `Hermes Ops` | Name shown on the phone panel |
| `TELEGRAM_CHAT_TITLE` | `On-call · Telegram` | Subtitle under it |
| `HERMES_STATE_DB` | auto-detected | The Hermes transcript the wall mirrors for phone → server messages. Found from `HERMES_HOME` or `%LOCALAPPDATA%\hermes\state.db`. **This is the default inbound source** |
| `HERMES_BRIDGE` | unset | `0` disables the transcript bridge entirely |
| `HERMES_BRIDGE_BACKFILL` | `8` | Recent transcript entries shown on attach, so a wall started mid-demo is not blank. `0` starts empty |
| `TELEGRAM_WALL_BOT_TOKEN` | unset | A **second** bot the wall polls for phone → server messages. An alternative to the bridge — see below |
| `TELEGRAM_POLL` | unset | `1` polls the shared `TELEGRAM_BOT_TOKEN` instead. **Conflicts with `hermes gateway`** |
| `TELEGRAM_ALLOWED_USERS` | unset | Comma-separated numeric ids allowed to appear on the wall |
| `SIM_WORLD_WINDOW_S` | `60` | How long the simulated families hold still — shared with the MCP tools |
| `HERMES_MODEL` / `HERMES_ACCELERATOR` | Qwen3-4B / Hexagon NPU | Header captions only — the page never talks to the model |
| `ACCESS_STATE_PATH` | `mcp-tools/.state/access.json` | Open challenge + the access audit trail |
| `ACCESS_ROSTER_PATH` | `mcp-tools/.state/roster.json` | Enrolled people. **Embeddings only, never images** |
| `ACCESS_IDENTITY_METHOD` | `stub` | Identity rung: `stub` \| `qr-badge` \| `face-npu` \| `face-cpu`. `stub` (detection-only) is the process default; `face-cpu` is built and claimed — verified live 2026-08-06 — see [../phone/README.md](../phone/README.md#the-identity-ladder) |
| `ACCESS_MATCH_THRESHOLD` | `0.5` | Cosine similarity for a face match. Code default is a starting point, not a calibrated value. The project's own measured value is **0.43, provisional** — genuine n=23 (min 0.7702), impostor n=46 (max 0.1026), 2026-08-06 — re-measure against the actual enrolled faces before trusting it on a larger roster |
| `ACCESS_DOOR_LOOKBACK_MS` | `30000` | How far *before* a presence edge a door-open still counts as the same entry. Too short and a normal entry reads as tailgating |
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
| `GET /api/access/pending-photo` | The captured photo for an open, unmatched challenge — unauthenticated, like the other read-only GET routes; held in memory only, 404 once decided or abandoned |
| `POST /api/access/capture` | `{imageBase64?, badges?}` → identify → verdict |
| `POST /api/access/approve` | `{id, decision, decidedBy}` — authorise or refuse a challenge |
| `POST /api/access/enroll` | `{name, embedding, method}` — add to the roster |

## The six tabs

| Tab | Answers | Live? |
|---|---|---|
| **Executive overview** | What Hermes is, what it is not, what was built and what was not, the team, why on-device | Static |
| **Conceptual architecture** | What the parts *are* — three devices, the links between them, the components on each | Static |
| **Logical architecture** | What *moves* — the six stages from a bus read to a page on the phone, and the three branches that are allowed to act | Static |
| **Live system** | The projector-scale summary — risk verdict, four channel tiles, network/storage/compute, and the phone thread, 60/40 split. Defaults into **demo mode** (below) the moment you navigate to it | Every 2s, or scripted in demo mode |
| **Live details** | The full technical dashboard this used to be alone: sparklines, evidence, per-device feeders, the processing log. Always the real feed — demo mode never touches it | Every 2s |
| **Detailed architecture** | Conceptual + logical, stacked on one scrolling panel, for a Q&A that wants both without flipping tabs | Static |

The four prose/summary tabs (Executive overview, Conceptual architecture,
Logical architecture, Live system) are sized for a projector — read from the
back of a room, not a laptop in someone's lap. Live details and Detailed
architecture are the reference tabs and are expected to scroll.

Conceptual and logical are deliberately separate. "What did you build" and "how
does a reading become a page" are different questions, and one diagram trying to
answer both answers neither. Live system and Live details are separate for the
same reason, one level down: a room six feet from the wall needs the verdict and
the phone, not a three-column technical dashboard.

### Demo mode

Real demos depend on a real leak, a real door, a real disk filling up —
conditions nobody can guarantee will happen on cue in front of a room. **Live
system** carries a Live/Demo toggle (top right of the tab) for exactly that
risk. Toggle state is entirely client-side in `app.js`; nothing about it
touches the server, the sensor log, or any file `/api/stream` reads from.

- **Defaults on.** Navigating to the Live system tab starts demo mode if it
  isn't already running — a no-op if it is, so it never restarts a loop in
  progress. Toggle it back to Live to watch the real feed on this tab instead;
  a global amber **"DEMO MODE · SIMULATED DATA"** badge in the header stays
  visible on every tab for as long as it's running, specifically so switching
  tabs mid-demo can't be mistaken for a change back to real data.
- **Live details is never affected.** Every summary element demo mode writes
  to (`setTile`, `renderServer`, `renderAccess`, `renderPhone` in `app.js`) is
  guarded by `if (!demoMode)` on the Live details side of each write and
  unconditional on the Live system side — Live details keeps rendering
  `/api/stream` untouched throughout, on the same 2s cadence as always.
- **Three scripted scenarios**, each a full inbound-instruction →
  simulated-deviation → outbound-alert story, 10s of animation apiece, with a
  10s quiet gap between them, a 30s pause after the third, then repeat:
  1. **Environmental** — "notify me if temperature or humidity deviates ±20%
     from baseline"; temperature climbs and humidity drops to a ~20%
     deviation, then an alert reports both readings against baseline.
  2. **Door + presence** — "notify me when the door opens and an object is
     detected"; the door tile opens, presence goes from clear to present,
     then an alert reports the door open and an object detected passing
     through.
  3. **Storage remediation** — "if available storage drops below 5%, clear
     log files and restart services, then tell me what happened"; the
     storage card drops to a simulated 3%, recovers to ~92% within the same
     10s window, then an alert reports the drop, the remediation it
     recommends, and the recovered figure (the live agent is read-only by
     design — it recommends and a human acts; the scripted demo copy says
     the same).
  Only the active scenario's channel deviates — the other tiles hold a calm
  baseline throughout, so the tab never shows more than one thing happening
  at once. A one-time 10s quiet beat runs before scenario 1 the first time
  demo mode starts, so opening the tab doesn't launch straight into an alert.
- **The phone thread is demo mode's own thread**, not a filtered view of the
  real one — built from the same bubble renderer Live details uses, so the
  two directions, alignment and tags read identically, but the messages
  themselves are scripted. The frame's height is measured from the left
  column (`syncPhoneHeight` in `app.js`) rather than CSS stretch, specifically
  so a long scenario history scrolls inside the frame instead of growing it.

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
| Telegram thread | The watchdog's state file, the Hermes gateway's own transcript, plus anything posted to `/api/telegram` | **Real** — see the honesty rules below |
| Access card | `AccessSentry.update()` — the same object the phone terminal talks to | **Real** decision over real presence/door edges; identity depends on the configured rung |
| Pipeline stream / Sensor-log feed `activity` lines | `event: "activity"` lines in the sensor log — written by the UNO Q's own on-device LLM (SmolLM2-135M, CPU), not the laptop | **Real** — see [ONDEVICE_ACTIVITY.md](ONDEVICE_ACTIVITY.md). Distinct from the laptop's own inference above: the pipeline stream tags this `board-inference`, never `inference`, so the two are never conflated. There is no dedicated wall tile for this — a new inference is instead pushed to the phone as its own Telegram message (see the watchdog section below) |

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
  and re-challenged the same person on the next tick — approving a volunteer and then
  accusing them two seconds later.

Identity comes from a swappable rung (`ACCESS_IDENTITY_METHOD`); the process default is
`stub` (detection-only), but `face-cpu` is built and claimed — verified live 2026-08-06 — so an
enrolled person now resolves automatically and only an unmatched capture still reads as unknown
and needs a human decision from the photo. `qr-badge` and `face-npu` exist in code but are not
part of the current demo. Full ladder in
[../phone/README.md](../phone/README.md#the-identity-ladder).

**A matched capture never stores an image** — it is resolved to an embedding and dropped;
`mcp-tools/.state/roster.json` holds floats only. An **unmatched** capture is held in memory only
(never written to disk) so the wall's approval panel can show it — `GET /api/access/pending-photo`
— to the human deciding, and it is dropped the instant that challenge is decided or abandoned.
There is no liveness check on this path: a printed photo of an enrolled face could pass a match,
which is why every non-match still requires that human decision.

### `expected` withholds a page — how that actually works

This is the one rule that makes the system quieter, so it is worth stating exactly.

When the verdict is `expected` — a person **on the roster**, present while an
incident is live — the watchdog withholds the page. The chain is
`check-environmental.js` → `alert-skill/suppress.ts` → `access/decide.ts`, reading
`.state/access.json` across a process boundary. **One writer per file:** the
dashboard drives the sentry and owns `access.json`; the watchdog process only reads it.

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

   Such a page is annotated *"escalated while the on-call was on site — paging
   anyway"*, **not** the property-1 wording above. Both sentences describe a hold
   ending, and for a while both were the same sentence — so the one page meaning
   "this deteriorated while you were standing next to it" read as routine
   catch-up for a rack that had not changed. The two are now told apart by a
   flag on the suppression decision, not by matching on its reason text.
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

### Every number on the wall is one decimal

The wall reads the sensor log directly rather than going through the environmental MCP tool, so it
applies the **same rounding at the same point** — `round1()` from `common/round.ts`, on the way in.
Without that, the sparkline and the agent would quote the same sample to different precision, and a
viewer comparing the screen to the phone would find them disagreeing in the last digit.

Whole numbers stay whole in the data (`25`, not `25.0`); only alert *text* pads to a fixed decimal.
Contract and rationale: [mcp-tools/README.md](../mcp-tools/README.md#one-decimal-place-applied-on-the-way-in).

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

1. **`watchdog · sent`** — the watchdog's state file changed, which only happens
   when a tick actually decided to send. A threshold alert bumps `lastAlertedAt`;
   a recovery clears it and drops `lastStatus` to `ok`, so recovery is detected
   from the status transition instead.

   A changed state file is evidence of a **decision, not a delivery**.
   `tick.ts` writes the state atomically *before* `watch-loop.ts` awaits the
   Telegram send, and that send swallows its own failures — so if the wall
   treated the state file as proof, every page would render delivered even with
   the WiFi off, which is the exact beat the demo turns off the WiFi to show.
   So a page enters the panel as recorded-but-unconfirmed (greyed, dashed,
   tagged `not delivered`, text ending *"[sending — delivery not yet
   confirmed]"*) and is promoted to a solid `watchdog · sent` bubble only when
   the health endpoint's `lastMessageAt` advances past the moment the page was
   recorded. That timestamp is written by `deliver()` *after* the Telegram call
   returns, so it is the only positive delivery evidence observable from outside
   the watchdog process.

   When promotion cannot happen the bubble says which of the three reasons
   applies rather than sitting silently grey: `lastDeliveryError` from the loop
   is quoted verbatim (*"[not delivered: …]"*, and it keeps retrying since the
   next send clears the error); a loop with `canDeliver: false` is terminal
   (*"[not delivered: watchdog has no Telegram credentials]"*); and if nothing
   answers the health port at all the wall admits the gap instead of inventing a
   verdict (*"[recorded by the watchdog; delivery not confirmed — no watch loop
   on the health port to report it]"*), because on the cron path there is no
   process that reports send outcomes.
2. **`queued · next tick ≤ 15s`** — running the *same* `decideAlert` the watchdog
   runs says an alert is due right now. The wall ticks every 2s, so it knows
   before the phone does. Rendered greyed, dashed and explicitly labelled. When
   the watchdog then fires, that exact queued text is re-posted as a recorded
   page and follows the promotion rule in (1) — it does not jump straight to a
   delivered bubble. The queued prediction is the one bubble in the thread with
   the fixed id `pending`; that is how the renderer tells "has not been sent
   yet" apart from "was sent, not yet confirmed", since both are `delivered:
   false`.

   The cadence in that tag is **measured, not assumed**: the server probes
   `http://127.0.0.1:7789/health` (cached 5s) and reports whatever interval the
   loop declares. If nothing answers, the tag falls back to
   `queued · next watchdog tick` and the **Watchdog process** row reads
   `no loop detected` in warning colour — because a watchdog nobody can see is
   indistinguishable from one that died, and that is the most expensive thing
   this panel could get wrong. It never guesses a number.

   The prediction is also made with `readingTrusted`, exactly as the watchdog
   makes it. Without that, a mock fallback reading would have the wall promise a
   page that the watchdog will correctly refuse to send.
3. **`gateway`** — real traffic, verbatim, either direction: an access challenge
   the sentry actually pushed to the phone (marked delivered or not by whether
   the Telegram call itself succeeded), a message read out of the Hermes gateway's
   own transcript, a message the inbound poller received, or anything posted to
   `POST /api/telegram`.

The alternative — letting the dashboard run its own alert loop against its own
state file — would produce a plausible message stream that no phone ever
received. Mirroring the real state file keeps the panel accountable.

One caveat the bridge does not paper over: Hermes's transcript records the turn,
not the HTTP result of the send, so an agent reply is weaker evidence than the
sentry's own pushes — those carry the actual call outcome and render as
**undelivered** with the error when the WiFi is off. A transcript reply is an
observed record of something the gateway produced and handed to Telegram; it is
not proof the phone's radio was on.

Both the watchdog and the dashboard build their alert text from
`src/alert-skill/summarize.ts`, so the wording on the wall is the wording on the
phone, character for character.

### The two directions, and which side of the thread they sit on

| Direction | Alignment | Where it comes from |
|---|---|---|
| **server → phone** | **left**, tagged `server → phone` | the watchdog's alerts, every access challenge the sentry actually pushes, and the agent's replies from the gateway transcript |
| **phone → server** | **right**, tagged `phone → server` | the gateway transcript bridge, the inbound poller, or anything posted to `/api/telegram` |
| wall's own notes | centred, tagged `wall` | the dashboard itself; never a Telegram message |

Alignment and the tag say the same thing twice on purpose. Someone reading this
across a room gets the direction from which rail the bubble hangs off; a
screenshot of a single bubble has no other side to compare against, so the tag
spells it out.

Outbound pushes carry the send's real outcome: a challenge that failed to reach
Telegram (the WiFi-off beat guarantees one will) shows as an **undelivered**
bubble with the error, not a confident outbound message.

### Getting phone → server messages onto the panel

Both directions work with no configuration, via the **gateway transcript bridge**
(`src/dashboard/gateway-bridge.ts`). The panel's header says which state the
inbound path is in (`receiving from phone` / `outbound only` / `inbound blocked`)
so a quiet thread is never mistaken for a broken one.

⚠️ **Telegram's `getUpdates` is single-consumer per bot token.** `hermes gateway`
long-polls `TELEGRAM_BOT_TOKEN` for the entire demo — that is how a question from
the phone reaches the agent. If the wall polled the same token, Telegram would
answer one of them with `409 Conflict` and the two would starve each other. A
display that breaks the thing it depicts is the worst failure available here.

So the wall does not poll Telegram. It reads what the gateway already wrote down:

**The bridge (default).** Hermes keeps a durable transcript in
`%LOCALAPPDATA%\hermes\state.db` — one row per message, with the role, the
verbatim text, the real timestamp and the session's platform. The dashboard opens
that file **read-only** and mirrors the Telegram sessions onto the panel. No
polling, no token, no conflict, and both directions come out verbatim rather than
reconstructed. It is found automatically from `HERMES_HOME` or `%LOCALAPPDATA%`;
point it somewhere else with `HERMES_STATE_DB`, or turn it off with
`HERMES_BRIDGE=0`. On startup the server prints which file it is mirroring.

An agent transcript is a working record, not a chat log, so the bridge drops
everything a human never saw: `tool` and `session_meta` rows, assistant rows with
empty content (those are tool-call turns), and Hermes's bracketed control markers
(`[SILENT]`, `[This response was interrupted…]`). Rendering one of those as a
delivered reply would put words on the wall the on-call never received.

`node:sqlite` is Node 22.5+ and this package's floor is Node 20, so on an older
runtime the bridge reports that on the panel instead of failing — as it does when
there is no Hermes install at all, which is the normal case for someone who just
cloned the repo.

Two alternatives, for a machine with no Hermes on it:

1. **A second bot.** Make another bot with
   [@BotFather](https://t.me/BotFather) and set `TELEGRAM_WALL_BOT_TOKEN`.
   Nothing else polls it, so there is no conflict. Message *that* bot from the
   phone and it appears on the wall within a second.
   ```powershell
   $env:TELEGRAM_WALL_BOT_TOKEN = "<second bot token>"
   $env:TELEGRAM_ALLOWED_USERS  = "<your numeric id>"
   npm run start:dashboard
   ```
2. **`TELEGRAM_POLL=1`** to poll the shared bot — **only** when the Hermes
   gateway is not running. If it is, the poller detects the 409, **shuts itself
   down permanently rather than fighting for updates**, and says so on the panel.

Both can run alongside the bridge; the panel reports the best state any source is
in. `TELEGRAM_ALLOWED_USERS` is the same allowlist Hermes uses. Set it: without
it, anyone who finds the bot can put text on a display standing in front of an
audience.

### Showing real phone traffic

Beyond the bridge, anything that already holds a message can push it straight in:

```powershell
curl.exe -X POST http://127.0.0.1:7788/api/telegram `
  -H "content-type: application/json" `
  -d '{\"direction\":\"inbound\",\"text\":\"what is the temperature in rack B1?\"}'
```

`direction` is `inbound` (phone → server) or `outbound` (server → phone); `text`
is required; `kind` and `at` are optional. Anything ingested pushes a frame
immediately rather than waiting for the next tick.

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
- **The phone panel stays pinned to the newest message**, and scrolling up to
  read older ones holds still rather than getting yanked back down on the next
  tick. Tracked with an `IntersectionObserver` on an anchor at the end of the
  thread rather than the panel's own `scrollTop`/`scrollHeight` — those read
  as `0` while the "Live system" tab is hidden, which otherwise locks the
  panel into believing it's already at the bottom the first time it measures
  a real backlog, and it never recovers on its own.
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

It is opt-in and unset by default on purpose: anyone must be able to clone and
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

### `tailscale serve` reaches a loopback bind — the startup warning cannot see it

The phone reaches the terminal because `tailscale serve` publishes port 7788 on
the tailnet and proxies to `127.0.0.1:7788`. Two consequences that the paragraph
above does not cover on its own, both true of the demo configuration as shipped:

- **The bind-address warning never fires.** It keys off `DASHBOARD_HOST`, which
  is still loopback. Publishing over Tailscale reaches the same audience-widening
  outcome by a route the check does not inspect, so *set `ACCESS_SHARED_SECRET`
  whenever the wall is served over Tailscale too* — the autostart path does.
- **Read paths are open to every tailnet device.** That follows directly from
  "the read paths are a display", and it is the intended trade, but state it
  plainly: anyone on the tailnet can read the sensor log, the roster names, file
  paths and the Telegram text without a key. The tailnet is a handful of enrolled
  devices rather than venue WiFi, which is why this is acceptable here and would
  not be on a public network.
- **Every request arrives as `127.0.0.1`.** The proxy is the client from the
  server's point of view, so the server *cannot* distinguish the operator's own
  browser from a tailnet visitor. Any future "only show this locally" idea is
  therefore not implementable at this layer — which is exactly why the access key
  is printed by a terminal script and not by an endpoint.

### Recovering the phone link

`scripts/show-phone-link.ps1` prints the ready-to-open phone URL (tailnet host
included, key appended), copies it to the clipboard, and **verifies the key
against the running dashboard** before telling you it is good. Run it when a
phone has lost its link, when a new phone joins, or as a preflight check.

The verification is the useful part. A phone holding a key from before the last
restart shows a page that looks completely normal and fails only at the moment
someone tries to capture — which during a live run reads as a broken camera, not
a stale key. The script probes a **write** route (an empty `/api/access/capture`
body, which cannot enrol or approve anything): `401` means the running server
rejects the key, `400` means it accepts it. Probing a read route would certify
any key at all, correct or not.

```powershell
scripts\show-phone-link.ps1                 # exit 0 = key verified, 2 = rejected
```

The URLs it prints contain the shared key, so it warns you not to put them on the
projector. Anyone holding the key can approve or deny rack access.

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
    telegram-feed.ts           the phone panel's message sources
    gateway-bridge.ts          read-only mirror of the Hermes transcript — inbound + replies
    telegram-poll.ts           optional second-bot poller, and why it must not be the first choice
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
