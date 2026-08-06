---
name: environmental-watch
description: Proactive watcher for the datacenter environmental sensor (temperature, humidity, leak detection). Runs the environmental-watch check script and, only if it reports a threshold crossing or a recovery, pushes a Telegram message about it. Used by a Hermes cron job, not called directly by users.
version: 0.1.0
metadata:
  hermes:
    tags: [monitoring, datacenter, proactive-alert]
    category: infrastructure
---

# environmental-watch

> ## ⚠️ This skill is NOT the production path any more
>
> Since **2026-08-05** the live proactive alert is a persistent process:
> [`../../src/alert-skill/watch-loop.ts`](../../src/alert-skill/watch-loop.ts), ticking every
> **15s**, delivering to the Telegram Bot API directly, supervised by the Scheduled Task
> `SMH-Hermes-Watchdog`. No LLM runs on a tick, so it costs zero tokens and cannot spam the phone
> (an edge-triggered decision with a cooldown, plus latched rule-engine errors). Rationale,
> measured latency and cutover: [`../../../docs/WATCHDOG.md`](../../../docs/WATCHDOG.md).
>
> **Before that** it ran in Hermes cron's `--no-agent --script` mode — a small Python wrapper
> ([`../../cron/environmental-watch.py`](../../cron/environmental-watch.py)) whose stdout Hermes
> relays verbatim ([wiring](../../cron/environmental-watch.cron.json)). That path still works and
> shares the same tick code, but measured over 547 executions it never ticked faster than ~2
> minutes whatever schedule it was given. **Run one watchdog, not both** — two writers of
> `environmental-watch.json` means every page arrives twice.
>
> **In no-agent mode `--deliver telegram` is correct** — read the `--deliver` warning below as
> applying *only* to the agent-session design described here, where the model narrates every run.
>
> This skill is retained for **manual/agent-narrated runs** and the demo narrative. If you rebuild
> the cron job from this file you will get the expensive design (~3 min of NPU per tick) and, if you
> also drop `--deliver`, no delivery at all.

This skill is the proactive-alerting half of the "Proactive alerting" plan in
`SMH-Hermes/docs/HARDWARE_UTILIZATION.md`. It is meant to be attached to a Hermes **cron** job, not
invoked directly from chat.

## What it does

1. Runs the pre-built check script:
   ```bash
   node "<MCP_TOOLS_DIR>/dist/alert-skill/check-environmental.js"
   ```
   where `<MCP_TOOLS_DIR>` is the absolute path to this repo's `mcp-tools/` directory (see
   `../../README.md` for how to set that up once, e.g. as an env var).
2. Read the script's stdout. It is always exactly one of:
   - `NO_ALERT` -- nothing crossed a threshold since the last check. **Do not send any message.**
     End your turn silently; this is the normal, expected outcome on most ticks.
   - `ALERT <status>` followed by a message line -- a threshold was just crossed (or the sensor
     just recovered to OK). Send that message text via your Telegram/messaging tool to the home
     channel, verbatim or lightly reworded for tone. Do not embellish with invented numbers.
3. That's it -- no other tool calls are needed. The script already decided *whether* to alert
   (using cooldown/edge-triggering logic, not "alert every tick") and already produced the message
   text; you only relay it.

## Why an *agent-session* job isn't wired via `--deliver telegram`

*(Applies to this skill's agent-narrated design only. The production no-agent script job **does**
use `--deliver telegram`, correctly — see the banner at the top.)*

Hermes' cron `--deliver` flag delivers the agent's reply on every single tick. That's right for
digest-style jobs ("summarize new feed items every hour") but wrong here: this check is designed
to be silent on most ticks and only speak up when something actually changes (a threshold crossed,
or recovered). So this skill instead relies on the agent's own ability to push messages
proactively via its Telegram gateway mid-session (confirmed available -- see "Proactive alerting"
in `HARDWARE_UTILIZATION.md`), gated by the script's own `NO_ALERT` vs `ALERT` output. Do **not**
add `--deliver telegram` to the cron job that runs this skill, or every tick will produce a
(mostly empty/no-op) message.

## Expected cron wiring

See `../../README.md` and `../../cron/environmental-watch.cron.json` for the exact command. In
short:

```
hermes cron create "every 1m" \
  "Follow the environmental-watch skill's instructions exactly: run the check script, then only message Telegram if it says ALERT." \
  --skill environmental-watch \
  --name "Environmental watch"
```

No `--deliver` flag.
