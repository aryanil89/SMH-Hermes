# hermes-hooks

Gateway hooks this project adds to Hermes. Hermes discovers them from
`%LOCALAPPDATA%\hermes\hooks\<name>\` (`HOOK.yaml` + `handler.py`) **at gateway startup only**,
so this directory is the source of truth and installing means copying plus a restart:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-hermes-hooks.ps1 -DryRun   # preview
powershell -ExecutionPolicy Bypass -File scripts\install-hermes-hooks.ps1
```

The installer syntax-checks and self-tests each handler with the gateway's own interpreter before
copying, and refuses to restart while a turn is in flight. **Re-run it after `hermes update`** —
that command rewrites parts of `HERMES_HOME`, the same way it reverts the non-streaming patch.

| | |
|---|---|
| Source of truth | `hermes-hooks/` (this directory, version-controlled) |
| Installed copy | `%LOCALAPPDATA%\hermes\hooks\<name>\` (not version-controlled) |
| Loaded | gateway startup, once (`gateway/hooks.py` → `discover_and_load`) |
| Failure mode | `HookRegistry.emit` catches and logs; a broken hook never blocks a turn |

That last row is also the trap: a hook that throws prints one line to the gateway log and the
turn carries on, which is indistinguishable from a hook that installed fine and never fired.
So each handler here carries a `--selftest` the installer runs, and logs its own degradations
rather than relying on being swallowed.

---

## `ack` — say the message landed, before the long silence starts

A tool-calling turn on this stack costs **60–300 s** (full-prompt re-prefill every call; there is
no KV cache in GenieX v0.3.18 — measured, `llm-serving-bench/RESULTS.md`). Until this hook
existed, the phone showed nothing in that window but Telegram's `typing…` bubble, which:

- expires ~5 s between refreshes, so it flickers rather than persists;
- never reaches the notification shade, which is where a phone in a pocket is actually read;
- looks identical whether the gateway is thinking, wedged, or dead.

The healthy path and every failure mode presented as the same thing: silence. The gateway now
answers twice — a receipt within a couple of seconds, then the answer.

```
> what's the temperature in rack B1?
  Pulling the temperature data from rack B1 now — about a minute.     (~2 s, italic)
  Rack B1 is 22.4 °C, humidity 41%, source: real (sensor age 12 s).   (~60 s, plain)
```

Italic on purpose: on a phone, the difference between a receipt and an answer has to survive a
glance at a notification.

### Why it blocks the turn it announces

`agent:start` is emitted immediately before `_run_agent`, and `HookRegistry.emit` awaits its
handlers — so this hook runs to completion before the agent's first model call. That ordering is
the whole design, because **GenieX serializes every request** (654 µs idle vs 1m42s queued behind
one completion; README troubleshooting table). A receipt generated in a background task would
queue *behind* the turn it announces and arrive after the answer it was meant to precede.

The cost is one short completion — ~200 prompt tokens, ≤48 out, **~2.3 s measured warm** — on a
60–300 s turn. When the model has unloaded (`--keepalive` idle), this call pays the reload the
turn was going to pay anyway and the agent's request then finds a warm model, so on exactly the
turns that felt worst the added cost is close to zero.

`HERMES_ACK_TIMEOUT_S` (default 12 s) is the hard ceiling on that delay; past it the receipt goes
out canned. The HTTP calls run on threads, because `emit` runs on the gateway's event loop and
blocking it would stall the typing-indicator cadence and the adapter heartbeats.

### It reports no findings, ever

The receipt is written before a single tool has run, so any status in it would be invented. A
confident fabricated *"no alerts on rack B1"* is worse than the silence this replaces — it is the
same failure as an alert with plausible invented numbers, which this project already treats as a
first-class risk.

Two layers stop it: the prompt forbids readings, numbers and "all clear" and shows a worked
WRONG/RIGHT pair, and a regex backstop drops any line that asserts one anyway, falling back to a
canned receipt and logging what it caught. This is not theoretical: an earlier prompt produced
*"Checking rack B1 cage door logs, no signs of entry yet"* — a status it had not looked up — which
is what motivated both layers. The hardened prompt ran 8/8 clean on the same question set; the
backstop stays regardless.

### Where the wait estimate comes from

Measured turns, this session's own. `agent:end` records each duration; the estimate is the median
of the last five, floored at the most recent and nudged up 10% — sessions only grow, prompt size
is the only latency lever here, so a symmetric estimator is biased low on every turn but the
first. It is capped at five minutes, which is where compression caps the worst measured turn
(293 s), and bucketed to *"under a minute" / "about two minutes"* — a fake-precise "97 seconds"
would be a claim the data does not support.

With no history it falls back to the measured priors in `RESULTS.md`: ~1 min/turn on a fresh
session, ~5 min near the 32K compression ceiling.

**The number is owned by the handler, not the model.** The model is asked to end its line with the
estimate verbatim; if it doesn't, the handler appends it. A 4B model is not trusted with an
arithmetic claim.

### Configuration

All optional — the defaults are the demo configuration. Set in `%LOCALAPPDATA%\hermes\.env`
(template: [`hermes.env.example`](../hermes.env.example)) and restart the gateway.

| Variable | Default | |
|---|---|---|
| `HERMES_ACK_ENABLED` | `1` | `0` disables the receipt without uninstalling the hook |
| `HERMES_ACK_TIMEOUT_S` | `12` | ceiling on how long a receipt may delay its turn |
| `HERMES_ACK_BASE_URL` | `model.base_url` from `config.yaml` | |
| `HERMES_ACK_MODEL` | `model.default` from `config.yaml` | |

Endpoint and model are read from Hermes' own config so the receipt cannot drift onto a different
model or port than the agent is using. State (per-session turn durations, ≤40 sessions, 24 h TTL)
lives in `%LOCALAPPDATA%\hermes\state\ack-hook.json`.

### Checking it without burning a Telegram turn

```powershell
$py = "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe"
& $py hermes-hooks\ack\handler.py --selftest              # offline: buckets, sanitiser, backstop
& $py hermes-hooks\ack\handler.py --try "is rack B1 hot?" # one live receipt, printed not sent
```

`--try` hits the real model server and prints the latency, so it doubles as a check that GenieX is
answering at all — and unlike `curl /v1/models` it is a request GenieX will actually serve rather
than a probe that hangs behind an in-flight completion.

### If Telegram itself is unreachable

The receipt send can fail for a reason that has nothing to do with the model — Telegram
unreachable, DNS down, the tailnet blipping. A failed send is queued to
`%LOCALAPPDATA%\hermes\state\ack-queue.json` rather than dropped, and the next inbound message
retries the single oldest queued entry before sending its own receipt — so a run of messages
during an outage drains the backlog one per turn, in the order they were meant to arrive. There
is no background process to retry on a timer; this hook only runs when a Telegram message does.

A receipt is a promise about *now* — "got it, ~2 minutes" delivered 20 minutes late is not a
receipt anymore, it is a confusing message about a turn the phone may already have the real
answer for. Anything older than 5 minutes is dropped instead of sent, and the queue is capped at
20 entries (oldest dropped first) so an outage that outlasts both limits does not grow the file
without bound.

### Known limits

- **Telegram only.** The CLI streams status locally and the wall renders the transcript as it is
  written; neither has the silence problem. `handle` returns early on any other platform.
- **Not on the wall.** The receipt is sent straight to the Bot API, so it never enters Hermes'
  transcript and `gateway-bridge.ts` never sees it. That is deliberate: the wall shows the
  conversation, not the plumbing around it.
- **One receipt per message, no coalescing.** Three questions in a row get three receipts.
- **The estimate is per session, not per question.** A question needing four tool calls and one
  needing none get the same estimate; only the session's own history moves it.
- **It cannot promise the answer arrives.** If GenieX is down, the receipt still goes out (canned)
  and the turn then fails with `model provider failed after retries`. The receipt narrows *"did it
  hear me?"* to *"it heard me and could not answer"* — which is the question that was actually
  unanswerable before.

---

## `failover` — when the laptop brain dies, the phone answers

The ack hook's last known limit ends *"it heard me and could not answer."* This hook exists to
delete that sentence when the reason is a dead GenieX: the question is answered anyway, by the
**second Hexagon NPU in the room** — the Samsung S25 Ultra's Snapdragon 8 Elite, over `adb`,
using the same `qualcomm/Qwen3-4B-Instruct-2507` model family the laptop serves (the phone runs
the AI Hub w4a16 Genie bundle; every config difference is tabled in
[`../llm-serving-bench/RESULTS.md`](../llm-serving-bench/RESULTS.md)).

```
> what should I check first if rack B1 runs hot?
  Got it — the model server is down, so this may take a little longer.   (~2 s, ack, canned)
  📱 phone-NPU failover — degraded mode, no tools:                        (~12 s)
  In degraded failover mode I cannot read live telemetry, so I cannot
  confirm current temperatures. Check fan operation and airflow first…
```

Hooks fire in `sorted()` directory order — `ack` < `failover` — so the receipt always precedes
the failover answer. The directory name is load-bearing.

### Down means *refused*, not slow — and never an HTTP probe

The repo rule stands: **never probe GenieX over HTTP** (654 µs idle vs 1m42s queued behind one
completion — README troubleshooting table). The probe here is a single stdlib TCP connect to the
host:port from `config.yaml`'s `model.base_url`:

- **connection refused → down.** Only a dead process refuses its own port.
- **anything else → up.** Accepted, timeout, odd socket error — a busy or wedged-but-alive
  GenieX still owns its listener, and a false failover during a long prefill would be worse
  than no failover.

One Windows-specific number worth keeping: a refused loopback connect takes **~2.03 s to
surface** (measured — Windows retransmits the SYN before giving up), so the probe timeout is
3 s. A shorter timeout turns "refused" into "timeout", which reads as UP, and the failover
would never engage. Healthy-path cost is unchanged: one ~1 ms connect per Telegram message.

### The phone path, honestly labeled

Prompt file (UTF-8, LF — never `-p`: adb's quoting layers shred a multiline prompt into argv,
learned during the benchmark) → `adb push` → `failover.sh` on the phone → `genie-t2t-run`
against the staged bundle → parse `[BEGIN]:…[END]` → deliver to **both** surfaces via the
existing plumbing: Telegram Bot API (HTML, one plain retry on a 400) and the wall's
`POST /api/telegram` intake (`kind: "system"`, `x-access-secret` header iff
`ACCESS_SHARED_SECRET` is set). Either surface failing is logged and never blocks the other.

Every answer is prefixed `📱 phone-NPU failover — degraded mode, no tools:` and the system
prompt forbids invented readings — same fabrication rule the ack hook enforces, because a
confident fake "rack B1 is fine" from a phone would be worse than silence.

Measured phone leg: **7.1 ± 0.7 s** (n=5, 2026-08-07 — `llm-serving-bench/phone/failover-reps.ps1`).
The decomposition is worth knowing before anyone tries to make it faster, because the obvious
lever is the wrong one: **3.83 ± 0.04 s of that is model load, paid on every question**, since
this is a one-shot `genie-t2t-run` with no resident process on the phone. Decode contributes
~0.04 s per generated token at 25.8 tok/s, and prefill — the number the phone benchmark makes
look impressive — is ~0.12 s of the total at these prompt sizes. So the leg is **~4.0 s fixed
+ answer length**; tuning prefill would buy nothing, and only an on-phone serving endpoint
(explicitly not built) would move the fixed 4 s. End-to-end, message→delivered, adds the ~2 s
refused-probe detection and Telegram delivery: **12.0 s, n=1**
([RESULTS.md](../llm-serving-bench/RESULTS.md#the-failover-round-trip-decomposed--n5-2026-08-07)).

Every failure sends an equally labeled, equally honest line instead — *phone not connected /
unauthorized / bundle missing / genie exited N / timed out* — because silence is exactly what
this hook replaces. An `asyncio.Lock` serializes phone runs: two concurrent questions must not
start two genie processes on a 12 GB phone; the second waits, then runs.

### What it does NOT claim

- **Not an offline mode.** Telegram still needs internet; the wall still needs the laptop. This
  is *compute* failover — the reasoning moves to the phone's NPU — not connectivity failover.
- **One-shot, no tools.** No sensor reads, no incident state, ctx 4096. It answers what can be
  answered from general knowledge and says so.
- **The doomed turn still dies.** The gateway's own turn then times out against the dead server
  (`model provider failed after retries`) and is discarded quietly — documented behavior this
  hook layers on top of, not a bug it introduces.
- **The demo beat needs the supervisor disabled.** `geniex-supervisor.ps1` resurrects a dead
  GenieX within ~15 s — by design. `scripts\demo-failover-ON.ps1` stops **and disables** its
  Scheduled Task (plus any manually started loops) and preflights the phone;
  `scripts\demo-failover-OFF.ps1` restores it. Without arming, a killed GenieX races the
  supervisor and usually loses.

### Configuration

All optional — defaults are the demo configuration. Set in `%LOCALAPPDATA%\hermes\.env`
(template: [`hermes.env.example`](../hermes.env.example)) and restart the gateway.

| Variable | Default | |
|---|---|---|
| `HERMES_FAILOVER` | `1` | `0` disarms without uninstalling |
| `HERMES_FAILOVER_ADB` | winget scrcpy adb, else `adb` on PATH | |
| `HERMES_FAILOVER_SERIAL` | auto-detect | pin the phone when several adb devices are attached |
| `HERMES_FAILOVER_TIMEOUT` | `90` | seconds; past it an honest failure line is sent |
| `HERMES_FAILOVER_PROBE` | `model.base_url` host:port, else `127.0.0.1:18181` | override rarely |

Phone prerequisites (demo dependencies through Friday): bundle staged at
`/data/local/tmp/hermes-npu-bench`, USB debugging **on**, Samsung Auto Blocker **off**.

**Two adb devices.** The UNO Q sensor board is an adb target as well as the phone, so
during the demo two devices are attached and `adb` refuses to guess — it exits 1 with
*"more than one device/emulator"* on every command. The hook resolves this itself: one
usable device means no pinning at all, several means it picks the one carrying the genie
bundle, and a genuine tie fails with both serials named rather than choosing wrong.
`HERMES_FAILOVER_SERIAL` overrules the whole thing. Entries listed `offline` or
`unauthorized` are never candidates — a stale `emulator-5554` stub appeared here the
moment the adb server was restarted, and treating it as a device would have pinned a
serial that cannot answer.

### Checking it without killing anything

```powershell
$py = "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe"
& $py hermes-hooks\failover\handler.py --selftest              # offline: 55 checks, exit 0/1
& $py hermes-hooks\failover\handler.py --probe                 # one TCP probe: UP=0, DOWN=2
& $py hermes-hooks\failover\handler.py --try "is rack B1 hot?" # real phone round-trip, print-only
```

`--try` runs the full production path (prompt file → adb → genie → parse) without sending a
message anywhere, so it doubles as the pre-demo warm rep and the phone-staging check.
