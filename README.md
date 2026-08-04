# Hermes: On-Device AI Operations Engineer
Project Hermes — Snapdragon Multiverse Hackathon 2026

Hermes is an AI operations engineer that runs **entirely on a Snapdragon X Elite** — no cloud AI, no
data leaving the laptop. It correlates real physical sensor signals with infrastructure telemetry to
tell an on-call engineer what is wrong, why it matters, and what to do next.

**What it is:** a local reasoning layer over signals an ops team already has — it correlates,
prioritises, explains and recommends.
**What it is not:** a replacement for monitoring, DCIM or sensors. Datacenters have those already.
Hermes does not collect the signals; it judges them.

The intelligence is offline: the model, the reasoning, the tool calls and the sensor path all run on
the device, and you can prove it by cutting the WiFi mid-demo. The one internet hop is the phone
notification — a message relay, not intelligence, and a swappable adapter (Slack, Teams, Discord,
WhatsApp and Signal are all supported by the same gateway; we demo on Telegram).

Built on [Hermes Agent](https://github.com/nousresearch/hermes-agent) + Qwen3-4B-Instruct-2507,
NPU-accelerated via Qualcomm GenieX, with infrastructure exposed through MCP tool servers.

> **Disclosure:** network, storage and compute telemetry are **simulated** with realistic data
> patterns; the environmental path is **live** from an Arduino UNO Q. The MCP adapters are the seam —
> the same tools can be pointed at real DCIM/BMS/SNMP without touching the reasoning layer. We
> measured the simulator's own false-positive rate and recalibrated it — see
> [docs/REVIEW_3_2026-08-04.md](docs/REVIEW_3_2026-08-04.md) §2.

## Status
**[PROGRESS.md](PROGRESS.md)** — the living done/next map. Read this first.
**[docs/POSITIONING.md](docs/POSITIONING.md)** — the approved wording: pitch, offline claim, judge answers.

## Run it yourself — the whole flow, in start order

The stack is five pieces. Start them in this order; each step says what it is, the exact command,
and how to know it worked. The flow being started:

```
[1] GenieX model server (NPU)  ←  [3] Hermes Agent  →  [4] Telegram gateway → phone
                                        ↑ stdio (automatic)
                                  [MCP tool servers: network/storage/compute = mock,
                                   environmental = real]
                                        ↑ log file
                                  [2] Arduino UNO Q sensors → USB or Tailscale
                                  [5] cron watchdog → proactive Telegram alerts
```

### 0. Setting this up on a fresh machine

Already provisioned on the demo laptop — skip to step 1 there. These are the reproducible steps
for anywhere else.

**Prerequisites**

| Need | Note |
|---|---|
| **Windows on ARM64** (Snapdragon X Elite / Copilot+) | The GenieX NPU path is win-arm64 only. An x64 machine can run everything *except* NPU inference |
| **Node 18+** | For the MCP tool servers (verified on v24.18) |
| **`adb`** | Only for the USB sensor transport. It ships inside the scrcpy package: `winget install Genymobile.scrcpy` — this is not obvious |
| **Telegram bot token** | From [@BotFather](https://t.me/BotFather); your numeric id from @userinfobot |
| QAIRT SDK 2.32+ *(optional)* | Only to re-run the NPU profiling in `bench/` |
| ~10 GB disk | Model artifacts: Q4_0 GGUF ~4.5 GB, W4A16 bundle ~3 GB |

**Install, in order**

```powershell
# 1. GenieX + the model. Q4_0 is load-bearing: Q4_K_M silently falls back to CPU.
#    Installer → %LOCALAPPDATA%\GenieX CLI\geniex.exe
& "$env:LOCALAPPDATA\GenieX CLI\geniex.exe" pull unsloth/Qwen3-4B-Instruct-2507-GGUF
& "$env:LOCALAPPDATA\GenieX CLI\geniex.exe" ls          # expect the Q4_0 precision listed

# 2. MCP tool servers
cd mcp-tools; npm install; npm run build; npm test      # expect 60/60 passing
cd ..

# 3. Hermes Agent — native ARM64 installer → %LOCALAPPDATA%\hermes\  (this is HERMES_HOME;
#    there is NO ~/.hermes on Windows). Then apply the non-streaming patch, see step 5.
.\install.ps1                                            # from the hermes-agent release

# 4. Secrets
copy hermes.env.example "$env:LOCALAPPDATA\hermes\.env"  # then edit in your token + user id
```

**5. Wire Hermes to GenieX and register the tools** — edit `%LOCALAPPDATA%\hermes\config.yaml`.
This file is the heart of the setup and cannot be inferred; these are the only parts that matter:

```yaml
model:
  default: unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0
  provider: custom                        # "custom" = an OpenAI-compatible endpoint
  base_url: http://127.0.0.1:18181/v1     # GenieX
  context_length: 65536                   # Hermes hard-requires >= 64K or it refuses the model

mcp_servers:                              # absolute paths — see "Paths to change" below
  network:
    command: node
    args: [ "<REPO>\\mcp-tools\\dist\\servers\\network-server.js" ]
  storage:
    command: node
    args: [ "<REPO>\\mcp-tools\\dist\\servers\\storage-server.js" ]
  compute:
    command: node
    args: [ "<REPO>\\mcp-tools\\dist\\servers\\compute-server.js" ]
  environmental:
    command: node
    args: [ "<REPO>\\mcp-tools\\dist\\servers\\environmental-server.js" ]
    env:
      UNOQ_SENSOR_LOG: "<REPO>\\arduino_uno_q-sensor_log.json"
      UNOQ_LOG_MAX_AGE_S: "180"           # older than this -> honest mock, not stale "real"
      # UNOQ_LEAK_DISTANCE_MM: "150"      # water-level leak threshold; unset = level detection off
```

**6. Proactive alert job** (see [mcp-tools/cron/](mcp-tools/cron/)):

```powershell
copy mcp-tools\cron\environmental-watch.py "$env:LOCALAPPDATA\hermes\scripts\"
hermes cron create --schedule "every 5m" --name "Environmental watch" `
  --script environmental-watch.py --no-agent --deliver telegram
```

**7. UNO Q app** — deploy `uno-q/hermes-sensor-logger/` to the board (see
[uno-q/README.md](uno-q/README.md)); it auto-starts via systemd.

#### Paths to change when moving machines

Every absolute path lives in exactly four places — grep for `C:\Users\qc_de` to find them all:

| Where | What |
|---|---|
| `%LOCALAPPDATA%\hermes\config.yaml` | 4 × `mcp_servers` args + `UNOQ_SENSOR_LOG` |
| `%LOCALAPPDATA%\hermes\scripts\environmental-watch.py` | `REPO_ROOT` (or set `SMH_HERMES_ROOT` instead of editing) |
| `bench/bench.py` | `SDK`, `GX`, `BUNDLE` constants — only if profiling |
| `docs/` | Illustrative paths in prose; harmless if left |

### 1. Model server — GenieX on the Hexagon NPU

```powershell
& "$env:LOCALAPPDATA\GenieX CLI\geniex.exe" serve --nctx 65536 --compute npu
```

Serves an OpenAI-compatible endpoint at `http://127.0.0.1:18181/v1`. First request after start
takes ~30s (model load). **Worked when:** the port answers —

```powershell
curl.exe -s http://127.0.0.1:18181/v1/models
```

Why these flags: Hermes needs 64K context (`--nctx 65536`) and `--compute npu` offloads to
Hexagon (CPU sits at 12–17% during generation vs 56–74% on CPU fallback — see
[docs/NPU_SPIKE_RESULTS.md](docs/NPU_SPIKE_RESULTS.md)). Don't use `--compute gpu`: faster
prefill, but reproducibly fails tool-enabled requests (GenieX preview bug).

### 2. Sensors — Arduino UNO Q → laptop log file

The board app auto-starts on boot and writes one `sensor_tick` line every 10s (plus one line per
button press) to its local log. Getting that file **to the laptop** has two transports — pick one:

**A. USB (bench / demo table — most reliable, zero network):**
```powershell
powershell -File uno-q\pull_sensor_log.ps1     # adb-pulls every 10s; leave it running
```

**B. Venue WiFi + Tailscale (the original push path):** nothing to start on the laptop — the
board's `hermes-sensor-logger-push.service` scp-pushes every 10s, *if* the board has WiFi and its
Tailscale is authed (`tailscale status` on the board; re-auth after long offline periods).

⚠️ **After any board power-up without network**: the UNO Q has no RTC battery — it boots in 1970,
all timestamps go wrong, and the staleness guard will (correctly) reject its data. Fix from the
laptop:
```powershell
$utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss")
adb shell "docker run --rm --user 0 --cap-add SYS_TIME --entrypoint date ghcr.io/arduino/app-bricks/python-apps-base:0.5.0 -u -s '$utc'"
```

**Worked when:** `arduino_uno_q-sensor_log.json` at the repo root gets a fresh `sensor_tick` line
every ~10–20s. If you edited the board app, redeploy with:
```powershell
adb push uno-q\hermes-sensor-logger\sketch.ino /home/arduino/ArduinoApps/hermes-sensor-logger/sketch/sketch.ino
adb push uno-q\hermes-sensor-logger\main.py /home/arduino/ArduinoApps/hermes-sensor-logger/python/main.py
adb shell "arduino-app-cli app restart user:hermes-sensor-logger"    # no sudo needed, ~1 min
```

### MCP tool servers — nothing to start

Hermes spawns all four (`network`, `storage`, `compute` — realistic mocks — and `environmental` —
real, reading the sensor log) automatically over stdio; they're registered in Hermes's
`config.yaml` under `mcp_servers`. To smoke-test the environmental chain **without** the agent:

```powershell
cd mcp-tools
node dist\alert-skill\check-environmental.js --json   # expect "source": "real", fresh ageSeconds
```

`"source": "mock"` + a `fallbackReason` means the sensor pipeline (step 2) isn't delivering —
the reason string says exactly why (stale log = clock or transport; missing file = pull loop).

### 3. The agent — Hermes on the laptop

`hermes.exe` is not on PATH by default — alias it once per shell (steps 3–5 all use it):

```powershell
Set-Alias hermes "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\hermes.exe"

hermes                                                  # interactive chat
hermes -z "check the rack-b1 to zone-east link"         # one-shot smoke test
```

**Worked when:** the one-shot answers with tool-derived data (latency/packet-loss numbers from
the network mock). Expect ~2–4 min per tool-calling turn (full-prompt re-prefill at ~280 tok/s on
the NPU) — keep demo questions to one tool call each. This step is the **offline demo beat**: it
works with WiFi off, because model, agent, and tools are all local.

### 4. The phone — Telegram gateway

```powershell
hermes gateway start      # background service (stop / restart / status also available)
hermes gateway status     # expect: running, telegram connected
```

**Worked when:** messaging the bot from the allowlisted phone gets an answer (2–4 min for
tool-calling questions). Note: Telegram is the one cloud hop in the system — it relays chat text
only; the LLM never leaves the laptop.

### 5. Proactive alerts — the cron watchdog

Already registered ("Environmental watch", every 5m, `hermes cron list` to confirm). It runs
`check-environmental.js` with **zero LLM cost per tick** and pushes to Telegram only on a
threshold crossing or recovery — silence is the normal state. To exercise it end to end:

1. Press **button C** on the UNO Q (logs a `leak_detected` event), or — if the water-level
   threshold `UNOQ_LEAK_DISTANCE_MM` is calibrated and enabled — actually raise the level
   (hand over the ToF sensor / water in the tray).
2. Within one 5-min tick (or immediately via `hermes cron run <job-id>`): **ALERT on the phone.**
3. ~5–10 min later: a one-time "recovered to OK" push — that's edge-triggered recovery working,
   not a bug.

### Quick health check, all five

```powershell
curl.exe -s http://127.0.0.1:18181/v1/models                      # [1] model server up
Get-Item arduino_uno_q-sensor_log.json | % LastWriteTime          # [2] fresh = sensors flowing
node mcp-tools\dist\alert-skill\check-environmental.js --json     # [tools] source: real
hermes -z "what's the temperature in rack B1?"                    # [3] agent + tools + NPU
hermes gateway status                                             # [4] telegram connected
hermes cron list                                                  # [5] Environmental watch active
```

## Troubleshooting — symptom → cause

Every row here cost us real time; none are hypothetical.

| Symptom | Cause | Fix |
|---|---|---|
| Telegram **questions** fail — *"model provider failed after retries"*; log shows `APIConnectionError … 127.0.0.1:18181` | **GenieX isn't running.** Nothing auto-starts it after a reboot | Redo step 1. Note the **cron alerts keep arriving while this is broken** — they never call the model, so "alerts are fine" is *not* evidence the agent is fine |
| Replies never finalize; Hermes retries forever | The non-streaming patch was reverted — usually by `hermes update` | Re-apply the patch and keep `HERMES_FORCE_NONSTREAM=1` |
| `"source": "mock"`, reason *"sensor log is stale"* | Board clock is wrong. The UNO Q has **no RTC battery**, so every power-up without network resumes hours behind and its timestamps look ancient | Set the clock — step 2 ⚠️. **Do this after every board boot on the USB path** |
| An alert arrives with plausible-but-invented numbers | Same as above. The mock fallback labels itself honestly, but the *severity* still reads as real | Check `source` before trusting any alert. `mock` = the physical path is down |
| Model answers but `tool_calls` is `null` | Wrong quantization — Q4_K_M | Use **Q4_0** |
| `SDKError(Model loading failed)` on tool-enabled requests | `--compute gpu` | Use `--compute npu` |
| Cron job fails every tick: `WSL (9 - Relay) … execvpe(/bin/bash) failed` | The job points at a `.sh`. Hermes picks the interpreter by **file extension**; `bash` here resolves only to WSL launchers, whose default distro has no `/bin/bash` | Use the `.py` wrapper (`--script environmental-watch.py`) |
| Cron passes when run by hand, fails on schedule | You verified a path the runtime doesn't use | Verify via a **real tick** — `last_status` in `cron\jobs.json` — never a one-off run |
| Priming the alert state changes nothing | PowerShell 5.1 `Set-Content -Encoding utf8` writes a **BOM**; `JSON.parse` fails and `readState` silently defaults to `ok` | `[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))` |
| `geniex` / `hermes` "not recognized" | Neither is on every shell's PATH | Use the full path, or `Set-Alias` (step 3) |
| `adb` not found | It ships inside the scrcpy package | `winget install Genymobile.scrcpy` |

Full end-to-end test procedure, layer by layer: **[docs/E2E_TEST.md](docs/E2E_TEST.md)**.

## Docs
- **[Glossary — who does what](docs/GLOSSARY.md)** — new to GenieX / QAIRT / QUAD / MCP? **Start
  here.** Every term with its one job, the five-layer stack, build-time vs demo-time, a request
  traced end to end, and the pairs that get confused for each other
- **[Architecture — end-to-end flow](docs/ARCHITECTURE.md)** — diagrams: the runtime demo path
  (sensors → agent → NPU → phone), both request flows (reactive + proactive), where QUAD sits and
  why it's a separate graph, and the one-model-two-artifacts table
- **[End-to-end test procedure](docs/E2E_TEST.md)** — board → phone, layer by layer, with a
  "Test / Expect / If it fails" per layer, the traps that produce a false pass, and a 60-second
  pre-stage smoke check
- [Response to the GPT review](docs/FEEDBACK_RESPONSE_2026-08-04.md) — accept/reject verdict on all
  30 proposed improvements, the four that don't survive scrutiny (latency budget, uncoupled
  simulators, additive risk double-counting, uncalibrated confidence), and the remaining build list
- [Requirements](docs/REQUIREMENTS.md) — the original pitch (see the note at the top — architecture has since changed)
- [Feasibility analysis](docs/FEASIBILITY.md) — reality check against the pitch's technical claims
- [Hardware utilization plan](docs/HARDWARE_UTILIZATION.md) — **the finalized architecture**: where
  the LLM runs, which model, and how the Snapdragon X Elite laptop, Samsung Galaxy S25+, Arduino
  UNO Q, and the QUAD SDK are each actually used
- [Technical claims audit (2026-08-03)](docs/AUDIT_2026-08-03.md) — independent review of every
  technical claim in the docs above against primary sources; **read the P0/P1 risks before Day 1**
  (Hermes's 64K-context minimum vs the 4K NPU-bundle cap, and unverified tool-calling through
  `geniex serve`)
- [NPU spike results (2026-08-03)](docs/NPU_SPIKE_RESULTS.md) — **the audit's P0/P1 risks are
  resolved**: live tests on the X Elite prove `geniex serve --nctx 65536 --compute npu` +
  Qwen3-4B-Instruct-2507 **Q4_0** GGUF gives Hermes a 64K, tool-calling, NPU-offloaded
  OpenAI endpoint (the qairt W4A16 bundle stays benchmark-only — 4K ctx, no tool-call parsing)
- [UNO Q setup (2026-08-03)](docs/UNOQ_SETUP.md) — how the board was provisioned (WiFi, Tailscale,
  SSH) and the original bring-up gotchas. The pull-contract gap it describes is **closed**: the
  board now emits periodic `sensor_tick` lines that feed the MCP environmental tool directly —
  see [uno-q/hermes-sensor-logger/README.md](uno-q/hermes-sensor-logger/README.md)
- [Benchmarks](docs/BENCHMARKS.md) — per-op Hexagon profiling results for the W4A16 bundle (all 8
  graphs, rc=0) with method + caveats; methodology in [docs/BENCHMARK_PLAN.md](docs/BENCHMARK_PLAN.md);
  harness in `bench/`
- [Code review + sensor plan (2026-08-03)](docs/REVIEW_AND_SENSOR_PLAN_2026-08-03.md) — findings
  CR-1..CR-8 and sensor upgrades S-1..S-6 with status markers (CR-1/2/3/5 + S-1 done, live-verified)

## Layout
- `mcp-tools/` — MCP servers (TypeScript) wiring network/storage/compute (realistic mocks) and environmental/physical (**real**, via UNO Q sensors) datacenter health data into the agent, plus the edge-triggered alert logic behind the proactive cron watchdog
- `uno-q/` — Arduino UNO Q app (`hermes-sensor-logger`: periodic `sensor_tick` + button events over two Bridge channels), the USB `pull_sensor_log.ps1` transport fallback, and deployment/bring-up docs
- `bench/` — NPU profiling harness (qnn-net-run against the W4A16 bundle); results in [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
- `hermes.env.example` — template for Hermes's own `.env` (copy to `%LOCALAPPDATA%\hermes\.env`); the
  only five settings that matter, everything else in Hermes's stock file can stay untouched
- `phone/` — Samsung Galaxy S25+ stretch goal: second on-device GenieX/Qwen3-4B instance for a two-device demo beat (not implemented)
