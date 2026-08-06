# Conversational alert rules

Ask for an alert in your own words over Telegram; the agent turns it into a rule,
checks whether that rule can actually fire, and arms it. Evaluation then runs in
plain code on every cron tick.

> "alert me every time the door opens for the next 24 hours"
> → `Armed as r1: every door_open until 05/08/2026 23:41.`

## The one architectural rule

**The model parses and explains. Arithmetic decides.**

| | When | Cost | Who |
|---|---|---|---|
| Authoring | once, when someone asks | slow is fine | LLM, via the `rules` MCP server |
| Evaluation | every 15 seconds, forever | **zero tokens** | `src/rules/evaluate.ts` |

This is not a style preference. One completion on the local Qwen3-4B takes one to
three minutes; a tick that needed the model could not run at any useful cadence,
let alone every 15 seconds. It is also why validation is a table lookup and a
comparison rather than a judgement call — a 4B model asked whether −100 °C is
plausible will agree that it is.

Tick cadence and rule cadence are separate. `event` rules evaluate on every tick;
`level` rules stay gated to five minutes behind `levelsEvaluatedAt`
(`UNOQ_LEVEL_INTERVAL_S`), so running the watchdog faster makes door and leak
alerts faster without making temperature alerts noisier. See
[WATCHDOG.md](WATCHDOG.md).

## Predicate shapes

| kind | Example request | Fires |
|---|---|---|
| `level` | "tell me when temp goes above 25" | if any sample since the last tick crossed |
| `sustained` | "if temp stays above 28 for 10 minutes" | when every sample across the window qualifies |
| `event` | "every time the door opens" | once per occurrence, batched per tick |
| `state_duration` | "if the door is left open 10 minutes" | when a state has been held that long |
| `stale` | built-in | when the sensor feed goes silent |

Every shape reads a **window**, never a single instant. The log carries 10-second
resolution and ticks are 5 minutes apart, so anything that inspects only the
newest line throws away 29 samples out of 30 — a kettle-length spike would be on
disk and reported nowhere. A `level` rule that fires on a spike which has since
passed reports the peak *and* says it recovered.

### The watermark is a log timestamp, never the clock

Every rule stores the timestamp of the newest **log line** it has examined, and
reads the window after it, so consecutive ticks tile the log with no gap and no
overlap.

It must not be "when the last tick ran". The board writes the timestamps and the
file arrives by a periodic `scp`, so a sample logged just before a tick routinely
lands in the file just after it. Flooring on wall clock drops those samples
permanently — a blind slice the width of the push latency on *every* tick, and
the width of the entire outage after a log-read failure (the clock keeps moving;
the log doesn't).

### `armedAt`

Set when a rule is created and again when a muted rule is resumed. It is the
floor an event rule counts from, which fixes two things at once:

- an event between "alert me when the door opens" and the next tick (up to 5
  minutes later) is still reported, rather than being skipped by a watermark
  adopted from the newest log line;
- resuming a muted rule delivers what happens *next*, not the whole backlog that
  piled up while it was silent.

System rules have no `armedAt` (their `createdAt` is the epoch), so they adopt
the end of the log on first sight and never replay history.

## Validation

Four verdicts, all computed from the datasheet table in `channels.ts` and from
observed history. **Reject** means the rule provably cannot fire; everything else
arms and warns, because the requester may know something the history doesn't.

| Check | Verdict | Example |
|---|---|---|
| Outside sensor range, or no such channel/event | **reject** | `temp < -100` → "the HS300x bottoms out at −40 °C" |
| Non-positive duration or window | **reject** | `forSeconds: -600` puts the cutoff in the future, so the rule is dead forever while looking armed |
| Never observed here | warn | `temp > 50` → "has stayed 22.2–35.7 over 31h" |
| Already true right now | warn | `temp > 25` → "it's 25.5 — expect it to fire next tick" |
| Noisy at the measured rate | warn | ">50 messages over the window" |

## What it learns

`rule-state.json` carries a `baselines` block, recomputed from the whole log each
tick: min/max/mean/stddev per numeric channel, events-per-hour per event. No
weights, no training, no model call — but it is what lets the agent say *"this
room has never gone past 35.7 °C in 31 hours, so that rule may never fire"*,
which nobody typed in.

Baselines are computed from the **raw** log values and rounded to one decimal on
the way out, like every other measurement the system reports
([common/round.ts](../mcp-tools/src/common/round.ts)) — that sentence is quoted
at an operator as a fact about the room, and `35.68359375 °C` reads as a dump,
not a measurement. Rule *thresholds* are unaffected: they are compared against
the reading the environmental tool returns, which is already rounded, and every
built-in threshold is an integer — an order of magnitude coarser than the
precision retained.

## Storage

```
mcp-tools/.state/
  rules.json        ← ONLY the agent writes.     definitions
  rule-state.json   ← ONLY the evaluator writes. watermarks, fire counts, baselines
```

Two files because two writers. Sharing one loses the evaluator's watermark
whenever the agent reads the file, holds it across a conversation and writes it
back — and every event in that gap alerts twice. Atomic temp-then-rename on both,
so no lock is needed.

Not a database: this holds tens of rows. Node 24 ships `node:sqlite` if firing
history ever needs to be queryable — a one-file change. A service (Postgres) is
not on that path.

**Missing and unreadable are different.** `ENOENT` is the normal first-run state
and safely means "no rules". Any other read failure (a lock, a scanner, a
concurrent rename) propagates instead, because treating it as "no rules" is
destructive twice over: the evaluator would prune every user rule's watermark,
and the agent's next write would overwrite the file with only the rule it just
created. On a degraded read the evaluator skips pruning and reports
`rulesError`; the agent refuses to write at all.

## Failure reporting is latched

Infrastructure failures — sensor log unreadable, `rules.json` unreadable,
evaluation threw — are reported to Telegram, because stderr from a background
process goes nowhere anyone looks. They are also **latched** in
`environmental-watch.json`: one message entering the failure, silence while it
persists, one line on recovery. Otherwise a permanently missing log would nag the
on-call phone every 15 seconds, which is the one thing every rule firing is
careful not to do.

The failure must also **persist for `RULE_ENGINE_GRACE_S` (default 120s) before
anyone is told**, and recovery only speaks if something was actually said. That
is not defensive padding: on a 25-minute soak of the 15s loop, reporting on the
first failing tick produced **11 degraded/recovered pairs** from transient file
locks on the sensor log. See
[WATCHDOG.md §7](WATCHDOG.md#7-the-false-all-clear-and-the-two-defences-against-it).

## Built-in rules

`src/rules/defaults.ts` — leak detected, temp above 28 sustained 10 min, humidity
outside 20–70 %, door left open 10 min, feed silent 10 min. They live in code, so
deleting `rules.json` restores the safety net rather than removing it.

Cancelling one writes a same-id override with `enabled: false`. So "stop telling
me about leaks" is obeyed and reversible, and a built-in can be muted but never
deleted by anyone in the chat.

## Testing without Telegram

```powershell
cd mcp-tools; npm run build

npm run rules -- baselines      # what it has learned about this room
npm run rules -- list           # armed rules, fire counts, expiry
npm run rules -- validate '{"kind":"level","channel":"temperature_c","op":"<","value":-100}'
npm run rules -- add      '{"kind":"event","channel":"door","match":"door_open","windowSeconds":86400}'
npm run rules -- check          # exactly what the cron watchdog would send
npm run rules -- cancel r1
```

`check` calls the same `runRuleTick()` the watchdog does, so its output is what
would arrive on the phone.

**`check` never writes state.** That is not a convenience — the only legitimate
consumer of a tick is `check-environmental.js`, whose output Hermes actually
delivers. A `check` that persisted would advance watermarks and set `fired`
latches for alerts it then printed to a terminal with no phone attached, eating
the exact message the next cron tick was going to send.

`--commit` rehearses state transitions, and is **refused unless
`ALERT_RULE_STATE_PATH` is set** — so "scratch logs only" is a property of the
tool rather than a line in this document that someone has to have read.

To rehearse against invented data instead of the live board, point the env at
scratch files:

```powershell
$env:UNOQ_SENSOR_LOG="scratch\log.jsonl"
$env:ALERT_RULES_PATH="scratch\rules.json"
$env:ALERT_RULE_STATE_PATH="scratch\state.json"
```

**Watch out:** appended test events must have timestamps *newer* than the
watermark. Events older than it are correctly ignored as already-seen, which
looks like a bug in the engine but is a bug in the fixture.

## Known data gap: door / light / leak are enter-only

31.5 hours of live log holds 6 `door_open`, 6 `light_on`, 5 `leak_detected` and
**zero** `door_closed`, `light_off` or `leak_cleared`. Only `presence` has both
edges. So in the current firmware those three channels report entering a state
and never leaving it.

Two consequences, neither of which the evaluator can fix — the arithmetic is
correct, the data is incomplete:

- `sys-door-left-open` reports the door open for hours from a log that never
  recorded it closing. The firing text now says so explicitly ("no `door_closed`
  has ever been logged — this is a lower bound"), and drops that caveat
  automatically once the board proves it emits the closing edge.
- Because the latch only clears on the exit edge, the rule fires **once** and
  then stays quiet forever. It reads as armed and is effectively spent.

Fix at the deployment seam, not in the evaluator: press button A (press *and*
release) and confirm `door_closed` lands in the log. Do not add
"distrust-an-old-edge" heuristics — the edge isn't implausible, it's the only
kind this firmware emits.
