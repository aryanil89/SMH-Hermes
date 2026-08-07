# The environmental watchdog

*Written 2026-08-05, from measurements taken on the live rig on the same day.*

The proactive path: the thing that pages the on-call phone when nobody asked it
anything. This page is the authority on **how fast it is, why, and which process
is running it** — every other document should defer to it rather than restate a
cadence.

---

## 1. What runs

There are two implementations of the tick, and they share the decision code
(`src/alert-skill/tick.ts`) so they cannot drift:

| | `watch-loop.ts` (**current**) | `hermes cron` job (legacy) |
|---|---|---|
| Cadence | every **15s** (`WATCH_INTERVAL_MS`, floor 5s) | every **~2 min**, and not configurable below that |
| Started by | Task Scheduler task `SMH-Hermes-Watchdog` | Hermes agent's in-process scheduler |
| Delivers via | Telegram Bot API, directly | Hermes gateway (stdout contract) |
| Observable | `GET http://127.0.0.1:7789/health` | `hermes cron list` |
| LLM tokens per tick | zero | zero (`no_agent: true`) |

**Run exactly one of them.** Both persist `.state/environmental-watch.json`; two
writers means the on-call gets every page twice and the cooldowns race.
`scripts/install-autostart.ps1` refuses to install the loop while the cron job is
enabled, and will not override that without `-Force`.

**Live on the demo laptop (2026-08-07): the Task-Scheduler loop.** The cron variant
is retired there — documented as the fallback, not running.

---

## 2. Why the loop exists: the cron path cannot go fast

Hermes cron floors out somewhere around two minutes, for three independent
reasons, none of which any configuration value can reach:

1. **`parse_duration` has no seconds unit.** Its multiplier table is
   `{'m': 1, 'h': 60, 'd': 1440}`, so `every 15s` does not parse. Intervals are
   whole minutes or nothing.
2. **The ticker polls on a fixed 60s grid.** `InProcessCronScheduler` waits
   `stop_event.wait(60)` between sweeps, so nothing can fire off-grid.
3. **`next_run_at` is computed from *completion*, not from the due time.**
   `mark_job_run` sets `last_run_at = now`, and `compute_next_run` adds the
   interval to that. A tick that takes 0.23s lands its next due time 0.23s
   *after* the next poll, misses it, and fires on the one after.

The third is the one that bites. Measured over 547 executions in
`cron/executions.db`:

| Configured | Actual gap | Count |
|---|---|---|
| `every 1m` | **120s** | 415 |
| `every 5m` | **360s** | 113 |

Every interval is really **N+1 minutes**, and it jitters with tick duration. Tick
duration itself is not the problem — median 0.23s, max 11.03s.

## 3. The measured latency budget

Two real button presses on the board, timed end to end (sensor edge → message on
the phone), while the cron job was configured `every 1m`:

| Stage | `object_entered` | `door_open` |
|---|---|---|
| Board → laptop (push + write) | 6.8s | 14.1s |
| **Waiting for the next tick** | **7.5s** | **88.1s** |
| Tick itself | 0.23s | 0.23s |
| Telegram delivery | ~1s | ~1s |
| **Total** | **14.2s** | **102.2s** |

The wait was **~86% of the worst case**. That is what the loop removes: at 15s
the same unlucky press pages in roughly 15–30s instead of 102s.

## 4. Why 15 seconds, and not faster

The board writes about every 10s and the push lands about every 10s; the measured
transport leg was 6.8s and 14.1s. Below ~15s there is usually nothing new to
read, and every extra tick is another chance to catch the sensor log mid-replace
(see §7). `WATCH_INTERVAL_MS` accepts a floor of 5000ms, which is already
generous.

Ticks are **skipped, never queued**. If a tick overruns the interval, the next
one is dropped rather than stacked — a backlog would pile up against the same
locked file and each queued tick would deliver a decision made from stale state.
The count is visible as `skipped` on the health endpoint.

---

## 5. Running it

```powershell
cd mcp-tools
npm run build
npm run start:watch          # foreground, Ctrl-C to stop
```

Under Task Scheduler (survives reboot, restarts on crash):

```powershell
.\scripts\install-autostart.ps1 -Only watch -DryRun   # see what it would do
.\scripts\install-autostart.ps1 -Only watch
```

### Environment

| Variable | Default | Effect |
|---|---|---|
| `WATCH_INTERVAL_MS` | `15000` | Tick cadence. Floored at 5000. |
| `WATCH_HEALTH_PORT` | `7789` | Health endpoint **and** single-instance mutex. `0` disables both. |
| `TELEGRAM_BOT_TOKEN` | — | Required to page. |
| `TELEGRAM_CHAT_ID` | — | Required to page. |
| `ALERT_STATE_PATH` | `.state/environmental-watch.json` | Persisted alert state. |
| `ACCESS_STATE_PATH` | `.state/access.json` | Read-only here; the dashboard owns it. |
| `UNOQ_SENSOR_LOG` | `../arduino_uno_q-sensor_log.json` | Defaulted at startup if unset. |
| `RULE_ENGINE_GRACE_S` | `120` | How long a rule-engine failure must persist before it is reported. See §7. |

**Without the Telegram credentials the loop still runs**: it ticks, evaluates,
persists state and logs what it *would* have sent, prefixed `NOT DELIVERED`. The
wall says so too — the phone panel shows `loop · every 15s · cannot page`. This
is deliberate; a watchdog that refuses to start because it cannot page is a
watchdog that tells you nothing at all.

### Is it alive?

```powershell
curl.exe http://127.0.0.1:7789/health
```

```json
{
  "startedAt": "2026-08-05T17:20:11.004Z",
  "ticks": 412, "skipped": 0, "failures": 0,
  "delivered": 3, "undelivered": 0,
  "lastTickAt": "2026-08-05T19:03:26.881Z",
  "lastStatus": "ok", "lastSource": "real",
  "intervalMs": 15000, "canDeliver": true
}
```

`lastSource` is the one to watch. `"mock"` means the real feed is not reaching
the tick, and although a mock reading can no longer *page* (§7), it also means
nothing real is being watched.

The port doubles as the mutex: a second instance exits 1 with a message rather
than quietly double-paging. A bound port is released by the kernel when the
process dies, so unlike a pidfile it cannot go stale and lock out the next start
after a crash.

### Cutting over from the cron job

This stops the current alerting path, so it is a deliberate, manual step:

```powershell
hermes cron delete f47e35e60c09          # 'Environmental watch'
.\scripts\install-autostart.ps1 -Only watch
curl.exe http://127.0.0.1:7789/health    # confirm ticks are climbing
```

To go back, re-create the cron job (`README.md` §"Proactive alerts") and
`Unregister-ScheduledTask -TaskName 'SMH-Hermes-Watchdog'`.

---

## 6. What a tick actually does

`src/alert-skill/tick.ts`, in order:

1. `getEnvironmentalReading()` — newest line of the pushed sensor log.
2. `readState()` — the persisted `lastStatus` / `lastAlertedAt` / `heldPage`.
3. `decideAlert()` — edge-triggered: only a *crossing* or a *recovery* speaks.
4. `evaluateSuppression()` — if a known responder is physically at the rack, the
   page is **held, not cancelled** (`lastStatus` is deliberately not advanced, so
   it fires the instant they leave).
5. `runRuleTick()` — user-authored and built-in rules, in plain code, zero tokens.
6. `readLatestActivity()` — the newest `event: "activity"` line, if any: the UNO
   Q's own on-device LLM correlating its sensor history (SmolLM2-135M, see
   docs/ONDEVICE_ACTIVITY.md). Compared against the persisted `lastActivityAt`
   watermark, not run through `evaluateSuppression` above -- "someone is at the
   rack" isn't a reason to withhold "someone just entered the room" the way it
   is for an environmental threshold the responder is already looking at.
7. `writeState()` — atomically, before anything is delivered.
8. Return the lines to send. Usually there are none, and that is the point.

Rule cadence is independent of tick cadence: `event` rules evaluate every tick,
`level` rules stay gated to five minutes behind `levelsEvaluatedAt`
(`UNOQ_LEVEL_INTERVAL_S`). Running the loop faster does not make temperature
rules noisier.

---

## 7. The false all-clear, and the two defences against it

**Observed on the live rig, 2026-08-05.** A tick hit `EBUSY` while the sensor log
was being atomically replaced mid-push. `readSensorLogReading` returned
`{ok:false}`, `getEnvironmentalReading` fell through to the **mock** generator,
and the watchdog paged **"recovered to OK"** while the rack was actually at 35°C
and 86% humidity — and reset `lastStatus` on the way, so the real excursion could
never re-page. A one-in-a-hundred file lock became an all-clear during a real
incident.

Two fixes, and the second is the load-bearing one:

1. **`common/read-retry.ts`** — retry the Windows sharing-violation family
   (`EBUSY`, `EPERM`, `EACCES`, `UNKNOWN`), 4 attempts, 50ms apart. `ENOENT` is
   deliberately *not* retried: a genuinely missing log is a real condition that
   `sys-feed-stale` exists to report. This narrows the window.
2. **`readingTrusted` in `decide-alert.ts`** — a reading whose `source` is not
   `"real"` returns `kind: "untrusted-reading"` and moves nothing: no alert, no
   recovery, and `lastStatus` is carried forward verbatim. This makes the window
   *harmless*. The dashboard passes the same flag, so the wall's "queued" bubble
   never promises a page the watchdog will refuse to send.

The write side is the mirror image and is handled in `common/atomic-write.ts`:
every state file is written temp-then-rename, and the rename retries the same
transient codes, because on Windows a rename over a file another process has open
fails rather than waiting.

### And a third: don't report a blip as an outage

Found on a **25-minute soak of the loop**, not by reading the code. The rule
engine reported its own infrastructure failures immediately, so every transient
`EBUSY` produced a *"rule engine is degraded"* line followed a tick later by
*"rule engine has recovered"* — **11 such pairs in 25 minutes**, all of which
would have gone to the on-call phone. The retry above narrows the window; at a
15s cadence against a file with four concurrent parties on it, narrow is not
zero.

A failure now has to persist past `RULE_ENGINE_GRACE_S` (default 120s, eight
ticks) before anyone is told, and **recovery only speaks if the failure was
actually reported** — otherwise a blip nobody heard about would still produce an
all-clear about it. State carries `ruleEngineErrorSince` and
`ruleEngineReported` alongside the error to make that decidable across ticks.

This is the same two-threshold shape as §8: *"is this working?"* and *"should I
wake someone?"* are different questions. 120s is one tick on the legacy ~2-minute
cron path, so that path behaves exactly as it always did.

---

## 8. The two staleness thresholds (this is deliberate)

They look like a bug and are not:

| Threshold | Default | Meaning |
|---|---|---|
| `UNOQ_LOG_MAX_AGE_S` | 180s | "Is this reading usable?" Older → the file source declines and the reading falls back to mock — which, per §7, is now inert. |
| `sys-feed-stale.forSeconds` | 600s | "Should I wake someone?" Older → page the on-call that the feed is down. |

Between 180s and 600s the system is knowingly quiet: it will not act on data it
does not trust, and it will not wake anyone over a gap that a board reboot or a
Tailscale reconnect routinely produces. The cost is a **~7 minute worst case**
between the feed dying and the phone hearing about it. That is a chosen trade, not
an oversight; narrow it by lowering `sys-feed-stale.forSeconds` if a demo needs a
faster proof that the board is gone.

---

## 9. Troubleshooting

| Symptom | Check |
|---|---|
| Wall says "no loop detected" | Is the task running? `Get-ScheduledTask SMH-Hermes-Watchdog`; then `curl.exe http://127.0.0.1:7789/health` |
| Loop exits immediately, exit 1 | Another instance holds port 7789. That is the mutex working — find it before starting another. |
| `canDeliver: false` | `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are not in the task's environment. |
| `lastSource: "mock"` | The sensor log is missing, stale, or unreadable. `sensor log not readable` / `is stale` in the log says which. |
| `failures` climbing | Read `lastError` on the health endpoint; the loop logs and continues by design. |
| Pages arriving twice | Both watchdogs are running. `hermes cron list` and the scheduled task. |
| Nothing pages during an obvious excursion | Edge-triggered, not level-triggered. If `lastStatus` is already `critical`, only a *recovery* or the one-hour cooldown re-notify speaks. Also check `heldPage` — someone may be standing at the rack. |

## 10. Inspecting a decision by hand

```powershell
cd mcp-tools
node dist\alert-skill\check-environmental.js --json
```

`--json` **implies a dry run**: it computes and prints the whole decision but
persists nothing. That matters — before this, inspecting the watchdog by hand
advanced the live rule watermarks and could swallow the next real alert.

Without `--json` the same binary prints the `ALERT <status>` / `NO_ALERT` stdout
contract *and does persist*, which is what the legacy cron wrapper relies on.
