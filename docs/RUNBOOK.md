# Runbook — restart, recovery, and health checks

Operating the stack once it is already installed. For a **fresh machine**, use
[README.md](../README.md#run-it-yourself--the-whole-flow-in-start-order) instead — this
document assumes everything is provisioned and something has gone wrong, or you are
bringing the demo up from cold.

Measurements below were taken on the demo laptop (Snapdragon X Elite, 31.6 GB) on
2026-08-05.

---

## 1. Is everything up? — the 30-second check

Run all of these. None of them block on inference.

```powershell
# GenieX: process + listening socket. NOT an HTTP call -- see the warning below.
Get-Process geniex -ErrorAction SilentlyContinue | Select-Object Id, StartTime
Get-NetTCPConnection -LocalPort 18181 -State Listen -ErrorAction SilentlyContinue

# The flags GenieX is ACTUALLY running with (they drift -- check, don't assume)
(Get-CimInstance Win32_Process -Filter "Name='geniex.exe'").CommandLine

# Hermes gateway
(Get-CimInstance Win32_Process -Filter "Name='hermes.exe'").CommandLine

# Sensor pipeline: this file must be seconds old, not minutes
Get-Item .\arduino_uno_q-sensor_log.json | Select-Object Length, LastWriteTime

# Board services
adb shell "systemctl is-active hermes-sensor-logger hermes-sensor-logger-push"

# Cron + rule engine
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\hermes.exe" cron list
Get-Content .\mcp-tools\.state\rule-state.json -Raw | ConvertFrom-Json |
  Select-Object -ExpandProperty levelsEvaluatedAt
```

Healthy looks like: GenieX listening; log `LastWriteTime` within ~20s of now; both board
units `active`; cron `Last run … ok` within the last minute.

### ⚠️ Never health-check GenieX over HTTP

GenieX **serializes every request behind a global lock**, including `GET /v1/models`.
Measured on 2026-08-05:

```
[GIN] 10:41:23 | 200 |         1m55s | POST "/v1/chat/completions"
[GIN] 10:41:23 | 200 |   50.8679762s | GET  "/v1/models"    <- queued behind it
[GIN] 10:41:23 | 200 |       654.9µs | GET  "/v1/models"    <- same call, queue empty
```

The same call is **654 µs** idle and **1m42s** behind a completion. An HTTP probe cannot
tell "busy" from "dead", and any timeout short enough to be useful will report false
deaths during normal inference. Process + socket is the only check that stays correct
while the model is thinking. (`README.md:198` suggests `curl /v1/models` — that is fine
on a cold start, misleading at any other time.)

---

## 2. GenieX — the piece that actually falls over

### Start it

```powershell
$env:Path += ";$env:LOCALAPPDATA\GenieX CLI"
geniex serve --nctx 65536 --compute npu --keepalive 3600
```

Every flag also has an env var (`GENIEX_NCTX`, `GENIEX_COMPUTE`, `GENIEX_KEEPALIVE`,
`GENIEX_HOST`, `GENIEX_NGL`, `GENIEX_DATADIR`), so a wrapper can set them once instead of
relying on anyone retyping the flags correctly.

There is **no `--model` flag**. The model is selected per request by the `model` field in
the API call, resolved against `%USERPROFILE%\.cache\geniex\models\`. Hermes sends
`unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0` from `config.yaml`.

### The flags are load-bearing

| Flag | Value | Why |
|---|---|---|
| `--nctx` | `65536` | **Must equal `context_length` in `config.yaml`.** Hermes builds prompts up to its declared context; if GenieX allocated less, the overflow lands on the server. |
| `--compute` | `npu` | Offloads to Hexagon. Measured 12.1% mean CPU across 12 cores vs 56–74% on CPU fallback ([NPU_SPIKE_RESULTS.md](NPU_SPIKE_RESULTS.md)). Do **not** use `gpu` — faster prefill, but reproducibly fails tool-enabled requests. |
| `--keepalive` | `3600` | Default is **300** — the model unloads after 5 min idle. See below. |

**Default `--nctx` is 4096**, nowhere near Hermes's 64K minimum. Omitting the flag does not
give you a smaller working setup; it gives you a broken one.

`--compute` unset auto-selects, and on this laptop it *did* pick NPU (measured 12.1% CPU).
Set it anyway — auto-selection is not a contract.

### `--keepalive 300` is why the first reply is slow

The model **unloads after 5 minutes idle**. The cron watchdog runs `--no-agent` (script
stdout goes straight to Telegram), so it never touches the model — nothing keeps it warm.
Between Telegram messages the model reliably falls out of memory and the next message pays
a full reload on top of prefill.

For a demo: `--keepalive 3600`, or send a throwaway message a minute before presenting.

### It exits silently under load

Observed 2026-08-05 during a plain 180-token request with other traffic in flight: the
**server** closed the connection, then the process was gone. No crash dump, no Windows
Application event, no log file. 17.7 GB RAM was free, so it was not memory pressure.

Root cause unknown. The leading hypothesis is the `--nctx` / `context_length` mismatch that
was live at the time (serving 32768, config declaring 65536). That is independently wrong
and worth fixing first.

**Until this is understood, run the supervisor rather than trusting the process:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\geniex-supervisor.ps1
```

It polls every 15s, restarts with the correct flags, warns if `context_length` disagrees
with `--nctx`, and logs to `%LOCALAPPDATA%\hermes\geniex-supervisor.log`.

**Only ever run one.** Each supervisor's restart path kills *every* geniex process, so two
of them take turns killing each other's server and the model reloads forever. Starting it
is a one-line command that looks idempotent, and two were running within six minutes of
each other on 2026-08-05 for exactly that reason. It now holds a named mutex and a second
instance refuses:

```
[FATAL] another supervisor already holds 'SMH-Hermes-GenieX-Supervisor' -- exiting without touching GenieX
```

**Health = the listener is owned by a geniex process**, not "a geniex exists" AND
"something listens". Those were both true while the listening server had 22 MB resident and
a second, orphaned 5.7 GB instance served nothing. The supervisor now logs orphans:

```
[WARN] orphan geniex pid 23888 holding 5721 MB and serving nothing -- Stop-Process -Id 23888
```

A freshly started GenieX sits at ~22 MB until the first request — the model loads lazily,
then stays resident for `--keepalive`. Low RSS on a just-started server is normal, not a
failed load.

⚠️ **Careful killing supervisors from PowerShell.** Matching on the command line matches
*your own shell* if the pattern text appears in the command you are typing — which it does.
Exclude `$PID`:

```powershell
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*supervisor*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

---

## 3. Hermes gateway

The gateway runs as a **Windows Scheduled Task** (`Hermes_Gateway`), installed by
`scripts\install-autostart.ps1`. Drive it through Hermes' own subcommands — never with
`Get-Process` / `Stop-Process`:

```powershell
# Location is not on PATH -- it lives in its own venv
$H = "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\hermes.exe"

& $H gateway status      # pid, state, telegram, active_agents
& $H gateway restart     # after any config.yaml edit
& $H gateway stop        # stop; the task restarts it at next logon
& $H gateway start       # start
```

**Do not use `Get-Process hermes | Stop-Process -Force`.** It has the same blast-radius
problem as the image-wide geniex kill in §2 — it matches *every* hermes process, including
CLI sessions and any agent mid-turn — and against a service-hosted gateway it fights the
task's restart-on-failure instead of stopping it cleanly.

**Do not run `& $H gateway` in the foreground while the task is installed.** Hermes refuses
that combination on purpose: the foreground instance leaves an orphan dispatcher that
escapes the service, survives restarts, and writes to the same `state.db` concurrently —
which can corrupt it.

There is no console window by design: the task launches via `wscript.exe`, because a
console-hosted gateway receives `STATUS_CONTROL_C_EXIT` at logon and Task Scheduler reads
that as a *user cancel*, so restart-on-failure would never fire. Use `gateway status` and
the log files instead of looking for a window.

`HERMES_HOME` is `%LOCALAPPDATA%\hermes` — there is **no `~/.hermes` on Windows**. Config,
secrets (`.env`), cron scripts, and `state.db` all live there.

**Restart the gateway after any `config.yaml` edit.** It reads config at boot only. A
gateway started before a config change is running the old wiring, which presents as tools
mysteriously not existing.

MCP servers need no separate start — Hermes spawns them over stdio. But they run from
`mcp-tools\dist\`, so **after any TypeScript change**: `npm run build`, then restart the
gateway.

---

## 4. Board (Arduino UNO Q)

```powershell
adb devices                                                        # expect "device"
adb shell "systemctl status hermes-sensor-logger --no-pager"       # the app
adb shell "systemctl status hermes-sensor-logger-push --no-pager"  # the scp push loop
```

Note the unit names — the push service is `hermes-sensor-logger-push`, **not**
`hermes-sensor-push`.

```powershell
# Restart the sensor app (~1 min, no sudo)
adb shell "arduino-app-cli app restart user:hermes-sensor-logger"

# Restart the push loop
adb shell "sudo systemctl restart hermes-sensor-logger-push"
```

**Boot takes ~70s.** Most of it is the board waiting for NTP before it starts Tailscale, so the VPN
never comes up on a 1970 clock — see
[boot sequence and timing](../uno-q/hermes-sensor-logger/README.md#boot-sequence-and-timing).
Power the board up well before you need it.

To reboot it, don't pull the cable — `adb reboot` is unsupported here and `reboot` needs polkit
auth, so go through the container as root:

```bash
adb shell 'sync; docker run --rm --user 0 --privileged -v /:/host \
  --entrypoint sh ghcr.io/arduino/app-bricks/python-apps-base:0.5.0 \
  -c "chroot /host /bin/systemctl reboot"'
```

**After a board power-up with no NTP reachable at all** (offline bench, captive portal), the UNO Q
boots in 1970 (no RTC battery) and the staleness guard correctly rejects its data:

```powershell
$utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss")
adb shell "docker run --rm --user 0 --cap-add SYS_TIME --entrypoint date ghcr.io/arduino/app-bricks/python-apps-base:0.5.0 -u -s '$utc'"
```

**Shell scripts pushed from Windows must be LF.** `.gitattributes` enforces this, but a
file edited outside git can still arrive with CRLF, and systemd then reports
`status=203/EXEC … No such file or directory` pointing at a file that plainly exists. Fix:

```powershell
adb shell "sed -i 's/\r$//' /home/arduino/ArduinoApps/hermes-sensor-logger/push_sensor_log.sh"
```

---

## 5. Rule engine

Two files, one writer each, under `mcp-tools\.state\`:

| File | Written by | Contains |
|---|---|---|
| `rules.json` | the **agent** (MCP `rules` server) | rule definitions |
| `rule-state.json` | the **evaluator** (cron tick) | watermarks, fire counts, baselines, `levelsEvaluatedAt` |

Never let one process write both — that is the lost-watermark race the split exists to
prevent.

```powershell
# What rules exist
Get-Content .\mcp-tools\.state\rules.json -Raw

# Is the evaluator ticking? (should be within the last ~5 min)
(Get-Content .\mcp-tools\.state\rule-state.json -Raw | ConvertFrom-Json).levelsEvaluatedAt

# Evaluate once by hand, without persisting
cd mcp-tools; node dist\alert-skill\check-environmental.js --json
```

**Cadence:** the cron runs every 1m. Event rules (door, leak) evaluate **every tick**; level
rules (temperature, humidity) are gated to 5 min behind `levelsEvaluatedAt`. Override with
`UNOQ_LEVEL_INTERVAL_S`.

**A `level` rule latches.** Once fired, `fired: true` and it will not fire again until the
value crosses back and re-crosses. A rule that "stopped working" has usually just already
done its job — check `fireCount` and `lastFiredAt` before debugging anything.

`lastTickAt` in `rule-state.json` is **dead data** from an older schema. Nothing in `src/`
writes or reads it; it survives via object spread. Ignore it — it is 10 hours stale by
design, not by fault.

---

## 6. What actually drives prefill cost

Measured, so nobody re-litigates this from intuition:

**Sensor log size is not a factor.** Reading and JSON-parsing the entire 848 KB / 5,572-line
log takes **4.6 ms** (1.1 read + 0.6 split + 2.8 parse). More importantly, raw log lines
**never enter the model's prompt** — `readSensorLogReading` returns a single summarized
reading (~150 tokens) and the cron runs `--no-agent`. Log growth costs Node CPU, not NPU
tokens.

The real prefill drivers, in order:

1. **Model reload** after `--keepalive` idle expiry — fix with `--keepalive 3600`.
2. **Fixed prompt overhead**, re-prefilled every agent iteration. Measured 2026-08-05
   against the production server (`docs/PERF-DESIGN.md` §0) — **9,825 tokens before the
   conversation says anything**, i.e. 78% of a real 12,670-token turn:

   | block | tok | trim? |
   |---|---|---|
   | built-in Hermes tool schemas | 4,353 | toolset-level only; `platform_toolsets.telegram` already minimal |
   | system prompt | 3,435 | 1,535 of it was the skills catalogue — **cut**, see below |
   | MCP tool schemas (10 tools) | 2,028 | **smallest block — do not trim** |

   The skills catalogue rendered 63 entries on every call and one was used here; it is now
   cut via `skills.platform_disabled.telegram` (saves 1,535 tok ≈ 7.5 s/call, ~22 s on a
   3-call turn). Earlier guidance in this file said "trim `mcp_servers`" — the measurement
   refutes that: MCP is the smallest block and pruning it would gut
   `get_incident_assessment`. **Do not turn `tool_search` back on** — it trades ~2k tokens
   for 2–3 extra full re-prefills, and Qwen3-4B will not perform the 3-hop dance.
3. **Conversation history** — `compression.threshold: 0.5` triggers compaction at half of
   `context_length`. Do **not** lower it to buy a latency cap: the target is
   `threshold × target_ratio`, and fixed overhead does not compress, so 0.25 fires
   compression roughly every 3 turns (~130 s each). See `PERF-DESIGN.md` P2. Never raise
   it either — ~60K crashes the NPU.
4. **Tool call count.** Each agent turn is a full re-prefill (2–4 min). Prefer
   `get_incident_assessment` (one call, all four families) over four separate status calls.

---

## 7. Symptom → cause

| Symptom | Likely cause |
|---|---|
| Telegram silent, rules still firing | GenieX down. The cron is `--no-agent`, so alerts survive the model dying. |
| First reply of the session takes minutes | Model reload after `--keepalive 300` idle. |
| `/v1/models` hangs | Normal — queued behind a completion. Not a fault. |
| Model replies in prose, calls no tools | `tool_search` re-enabled, or gateway not restarted after a config edit. |
| Tool "does not exist" | Gateway started before the `config.yaml` edit; or `npm run build` not run. |
| `"source": "mock"` + `fallbackReason` | Sensor pipeline down — the reason string says which half. |
| Board data rejected as stale | UNO Q booted with no NTP reachable → 1970 clock. With NTP, boot fixes itself in ~70s; without it, set the date. |
| `status=203/EXEC` on a file that exists | CRLF line endings on a board shell script. |
| Rule fired once, never again | `level` rules latch. Working as designed. |
| GenieX gone, no error anywhere | The silent-exit bug. Run the supervisor. |
