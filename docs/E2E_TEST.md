# End-to-end test — Arduino UNO Q → Telegram

Run this to prove the whole chain works, in the order the data actually flows. Each layer has a
**Test**, an **Expect**, and a **If it fails** so a red light tells you *which* layer broke instead
of "the demo is broken".

Budget ~15 minutes for the full pass; the 60-second smoke check at the bottom is the pre-stage
version.

> **The rule this document exists to enforce:** a single successful run proves nothing about the
> scheduled path. On 2026-08-03 the watchdog was declared "end-to-end verified" after one passing
> run, then failed **9 consecutive scheduled ticks** over ~50 minutes while looking fine. Always
> verify layer 7 the slow way.

## Paths on this machine

| Thing | Path |
|---|---|
| `HERMES_HOME` | `%LOCALAPPDATA%\hermes` — **not** `~/.hermes`, which does not exist here |
| `hermes` | `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe` |
| `geniex` | `%LOCALAPPDATA%\GenieX CLI\geniex.exe` (not always on a given shell's PATH — use the full path) |
| Repo | `C:\Users\qc_de\Downloads\QUAD\SMH-Hermes` |
| Pushed sensor log | `<repo>\arduino_uno_q-sensor_log.json` |
| Alert state | `<repo>\mcp-tools\.state\environmental-watch.json` |
| Cron job state | `%LOCALAPPDATA%\hermes\cron\jobs.json` + `cron\output\<job_id>\` |

Set once per shell:

```powershell
$H = "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\hermes.exe"
$G = "$env:LOCALAPPDATA\GenieX CLI\geniex.exe"
$R = "C:\Users\qc_de\Downloads\QUAD\SMH-Hermes"
```

---

## Layer 1 — the board is sampling and pushing

Everything downstream reads one file, so check it first.

**Test**
```powershell
$last = Get-Content "$R\arduino_uno_q-sensor_log.json" -Tail 1 | ConvertFrom-Json
$age = ([DateTime]::UtcNow - $last.timestamp.ToUniversalTime()).TotalSeconds
"age = {0:N0}s   event = {1}   temp = {2:N1}C   dist = {3}mm" -f $age, $last.event, $last.temperature_c, $last.distance_mm
```

**Expect** age **< 30 s**, `event = sensor_tick`. The board appends a periodic tick roughly every
10 s and pushes every 10 s, so anything over ~30 s means the pipeline is down.

**If it fails**
- Age is minutes/hours → the board isn't pushing. Check the board's Tailscale login and the
  `hermes-sensor-logger-push` service ([UNOQ_SETUP.md](UNOQ_SETUP.md)).
- File missing → wrong repo path, or the board has never pushed.
- **Age > 180 s is the dangerous case**: it does not error, it silently degrades to mock data
  (`UNOQ_LOG_MAX_AGE_S=180`). Layer 2 is what catches that.

## Layer 2 — the reading is REAL, not mock

The most likely way to demo a lie: everything "works" but the numbers are synthetic.

**Test**
```powershell
node "$R\mcp-tools\dist\alert-skill\check-environmental.js" --json
```

**Expect** `reading.source` = **`"unoq-log"`** (or another real source) and **no**
`fallbackReason`. Also note `reading.status` — `ok` / `warning` / `critical`.

**If it fails** `source: "mock"` means the log was stale, unreadable, or absent — `fallbackReason`
says which. Fix layer 1; do not proceed. A mock reading will still produce a perfectly convincing
Telegram alert, which is exactly why this check exists.

## Layer 3 — GenieX is serving the model on the NPU

**Test** (start the server if it isn't up)
```powershell
& $G serve --nctx 65536 --compute npu     # leave running in its own window
```
Then, in another shell, confirm it answers *and* emits structured tool calls:
```powershell
curl -s http://127.0.0.1:18181/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0",
  "messages": [{"role":"user","content":"What is the temperature in rack B1?"}],
  "tools": [{"type":"function","function":{"name":"get_environmental_reading",
    "description":"Get temperature/humidity/leak status for a rack",
    "parameters":{"type":"object","properties":{"rack_id":{"type":"string"}},"required":["rack_id"]}}}],
  "max_tokens": 128}'
```

**Expect** `"finish_reason": "tool_calls"` and a populated `tool_calls` array. First call after
start adds ~30 s of model load.

**Confirm it's really on the NPU**: during generation, CPU should sit at **12–17%**, not 56–74%,
and Task Manager's NPU graph should be active.

**If it fails**
- Tool calls come back `null` → wrong artifact. Must be **`Q4_0`**. `Q4_K_M` *silently* falls back
  to CPU, and the qairt `W4A16` bundle doesn't parse tool calls at all.
- `SDKError(Model loading failed)` on tool-enabled requests → you're on `--compute gpu`. GPU mode
  reproducibly fails tool calls; use `npu`.
- Port dead → server not running, or a stale process holds 18181.

## Layer 4 — Hermes reaches its tools (reactive path, no phone yet)

This isolates agent + MCP from Telegram.

**Test**
```powershell
& $H -z "check the environmental status of rack B1"
```

**Expect** a natural-language answer containing real sensor numbers, having called the
environmental tool. Allow **2–4 minutes** — that's the known per-iteration latency, not a hang.

**If it fails**
- 64K context rejection → `context_length: 65536` missing in `config.yaml`.
- Retries forever / never finalizes → the `HERMES_FORCE_NONSTREAM=1` patch is gone. Check:
  ```powershell
  Select-String -Path "$env:LOCALAPPDATA\hermes\hermes-agent\agent\conversation_loop.py" -Pattern "HERMES_FORCE_NONSTREAM" | Measure-Object
  ```
  Expect ≥1 match, and `HERMES_FORCE_NONSTREAM=1` in `%LOCALAPPDATA%\hermes\.env`. **`hermes update`
  reverts this patch — don't run it during hack week.**
- Invents numbers instead of calling a tool → prompt/toolset problem, not infrastructure.

## Layer 5 — Telegram outbound

No LLM, no gateway needed — pure credential check.

**Test**
```powershell
& $H send -t telegram "e2e test: outbound ok"
```

**Expect** the message on your phone within seconds.

**If it fails** check `TELEGRAM_BOT_TOKEN` in `%LOCALAPPDATA%\hermes\.env`, and that your Telegram
user ID is allowlisted and set as the home channel (`/sethome`).

## Layer 6 — Telegram round-trip

**Test** From the phone, message the bot: *"what's the temperature in rack B1?"*

**Expect** tool-call progress lines, then a real answer. **2–4 minutes** is normal. Scope demo
questions to a single tool call.

**If it fails** but layers 4 and 5 pass, the gateway is the problem:
```powershell
& $H cron status      # also reports whether the gateway is running
Get-Content "$env:LOCALAPPDATA\hermes\gateway-starts.log" -Tail 5
```

## Layer 7 — the proactive watchdog, via the SCHEDULER

**This is the layer that gave a false pass before. Do not shortcut it.**

**7a. Job is wired correctly**
```powershell
& $H cron list
```
**Expect** `Environmental watch`, `every 5m`, `Script: environmental-watch.py`,
`Mode: no-agent`, deliver `telegram`.
**It must be `.py`, never `.sh`** — Hermes picks the interpreter by extension, and on this box
`bash` resolves only to WSL launchers whose default distro (`docker-desktop`) has no `/bin/bash`,
so a `.sh` fails every tick with
`WSL (9 - Relay) ERROR: ... execvpe(/bin/bash) failed`.

**7b. A real tick succeeds and stays quiet**
```powershell
$f = "$env:LOCALAPPDATA\hermes\cron\jobs.json"
$b = (Get-Content $f -Raw | ConvertFrom-Json).jobs[0].last_run_at
do { Start-Sleep 10; $j = (Get-Content $f -Raw | ConvertFrom-Json).jobs[0] } while ($j.last_run_at -eq $b)
"status=$($j.last_status)  err=$($j.last_error)"
```
**Expect** `status=ok`, empty error, **no Telegram message** (nothing is wrong, so silence is
correct). The run's file under `cron\output\<job_id>\` should say `Status: silent (empty output)`.

**If it fails** the `last_error` is the whole diagnosis — it is verbatim stderr from the script.

**7c. Delivery actually works** — force one recovery alert. The run resets the state itself, so
this is self-reverting and needs no fake sensor data:
```powershell
$s = "$R\mcp-tools\.state\environmental-watch.json"
[System.IO.File]::WriteAllText($s, '{"lastStatus":"critical"}', (New-Object System.Text.UTF8Encoding($false)))
# then wait for the next tick exactly as in 7b
```
**Expect** a Telegram push: *"Environmental status has recovered to OK (was CRITICAL). …"*, and the
state file back to `{"lastStatus": "ok"}`.

> **Write it BOM-free.** PowerShell 5.1's `Set-Content -Encoding utf8` adds a UTF-8 BOM, which makes
> `JSON.parse` fail in `readState`; it silently defaults to `ok`, no recovery fires, and the tick
> reports `silent (empty output)` — looking like a pass while testing nothing. Use
> `[System.IO.File]::WriteAllText` as above.

## Layer 8 — the physical demo beat

**Test** Press **button C** on the UNO Q.

**Expect**
1. A `leak_detected` line appears in the log within ~10 s (re-run layer 1 to see it).
2. On the next tick — **up to 5 minutes** — the phone gets
   *"Environmental status is now CRITICAL. … LEAK DETECTED …"*.
3. ~5–10 minutes later, a **one-time** *"recovered to OK"* push, because the leak event ages out of
   its 5-minute window. **That is the edge-triggered recovery working, not a bug** — say so on
   stage before it lands.

**If nothing arrives** work backwards: log line present? (layer 1) → tick succeeded? (7b) →
delivery works? (7c).

---

## Traps that produce a false pass

| Trap | Why it fools you |
|---|---|
| One successful run "verifies" cron | The scheduled path can fail while a manual run succeeds. Only a real tick counts (7b). |
| `Set-Content -Encoding utf8` for state | BOM breaks `JSON.parse`; `readState` defaults to `ok` and the alert silently never fires. |
| Following docs that say `~/.hermes` | That's the Linux/WSL layout. Here it's `%LOCALAPPDATA%\hermes`. |
| Stale sensor log | No error — silently becomes mock data. Always check `source` (layer 2). |
| `Q4_K_M` instead of `Q4_0` | Silently runs on CPU. The NPU claim quietly becomes false. |
| `--compute gpu` | Faster prefill, but reproducibly fails every tool-enabled request. |
| `hermes update` | Reverts the non-stream patch; every reply then retries forever. |
| Empty watchdog output read as "healthy" | Correct when nothing is wrong — confirm with 7c that delivery *can* fire. |

## 60-second smoke check before going on stage

```powershell
$H = "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\hermes.exe"
$R = "C:\Users\qc_de\Downloads\QUAD\SMH-Hermes"

# 1. sensor log fresh?
$l = Get-Content "$R\arduino_uno_q-sensor_log.json" -Tail 1 | ConvertFrom-Json
"log age: {0:N0}s" -f ([DateTime]::UtcNow - $l.timestamp.ToUniversalTime()).TotalSeconds

# 2. reading real, not mock?
(node "$R\mcp-tools\dist\alert-skill\check-environmental.js" --json | ConvertFrom-Json).reading.source

# 3. model serving?
(curl -s http://127.0.0.1:18181/v1/models) -ne $null

# 4. gateway + cron healthy?
& $H cron status
(Get-Content "$env:LOCALAPPDATA\hermes\cron\jobs.json" -Raw | ConvertFrom-Json).jobs[0].last_status

# 5. phone reachable?
& $H send -t telegram "pre-stage check ok"
```

All green = log age < 30 s, source not `mock`, models endpoint answers, cron status `ok` with the
gateway running, and a message on the phone.
