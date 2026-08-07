# Hermes: On-Device AI Operations Engineer
Project Hermes — Snapdragon Multiverse Hackathon 2026

<!-- keep the tests badge in sync with the npm test count -->
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-361%20passing-brightgreen)](mcp-tools/#status)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-339933)](README.md#quickstart--three-rungs-pick-your-hardware)
[![Inference](https://img.shields.io/badge/inference-Hexagon%20NPU%2C%20on--device-E62E2E)](docs/EVIDENCE.md)

Hermes is an AI operations engineer that runs **entirely on a Snapdragon X Elite** — no cloud AI, no
data leaving the laptop. It correlates real physical sensor signals with infrastructure telemetry to
tell an on-call engineer what is wrong, why it matters, and what to do next.

**What it is:** a local reasoning layer over signals an ops team already has — it correlates,
prioritises, explains and recommends. It also reasons about **who is physically at the rack**, and
**asks a human before anything proceeds**.
**What it is not:** a replacement for monitoring, DCIM or sensors. Datacenters have those already.
Hermes does not collect the signals; it judges them.

The intelligence is offline: the model, the reasoning, the tool calls and the sensor path all run on
the device, and you can prove it by cutting the WiFi mid-demo. The one internet hop is the phone
notification — a message relay, not intelligence, and a swappable adapter (Slack, Teams, Discord,
WhatsApp and Signal are all supported by the same gateway; we demo on Telegram).

And "the device" is now three devices: **inference runs on three Snapdragon tiers**. The
laptop's X Elite Hexagon NPU serves the 4B agent; the Arduino UNO Q runs its own
SmolLM2-135M **on the board**, pre-correlating raw sensor history into `activity-*` events
before anything reaches the laptop (surfaced on the wall as "AI:" rows and folded into
Telegram pages); and a Galaxy S25 Ultra's 8 Elite NPU stands by as the measured compute
failover — GenieX dies, the phone answers in ~12 s, labeled degraded. Each tier is sized to
its job; every number is measured ([docs/EVIDENCE.md](docs/EVIDENCE.md)).

Built on [Hermes Agent](https://github.com/nousresearch/hermes-agent) + Qwen3-4B-Instruct-2507,
NPU-accelerated via Qualcomm GenieX, with infrastructure exposed through MCP tool servers.

> **Naming note:** *SMH-Hermes* (this project) is a hackathon configuration-and-tooling layer that
> **runs on** Nous Research's Hermes Agent runtime (MIT). It is not affiliated with, endorsed by, or
> a product of Nous Research; their Hermes *model* family is not used here (the model is Qwen3).

> **New here? Start at [docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md)** — the five-minute version:
> demo sequence with expected outcomes, the real-vs-simulated table, every measured number,
> and where each rubric category's evidence lives. This README is the long-form reference.

## Team

| Name | Email |
|---|---|
| Indranil Acharya (team lead) | `aryanil89@gmail.com` |
| Christopher Gould | `chrisxgould@gmail.com` |
| John Koch | `ghostboarder193@gmail.com` |


> **Disclosure:** network and storage telemetry are **simulated** with realistic data patterns, as
> is the six-node compute *rack*; the environmental path is **live** from an Arduino UNO Q, and one
> compute node is live too — `host-01` in `get_compute_status` is this laptop's real CPU, memory and
> uptime, read via Node's `os` and reported with its actual processor name (`Snapdragon(R) X Elite -
> X1E80100`). **Every compute node carries a `source` field of `real` or `mock`**, because one
> unlabelled real number sitting beside five invented ones is worse than no real number at all. The
> MCP adapters are the seam — the same tools can be pointed at real DCIM/BMS/SNMP without touching
> the reasoning layer. We measured the simulator's own false-positive rate and recalibrated it — see
> [docs/REVIEW_3_2026-08-04.md](docs/REVIEW_3_2026-08-04.md) §2.
>
> `get_incident_assessment` deliberately scores the **simulated** fleet only: its risk number has to
> be reproducible for a given seed, and a live CPU reading would make the same question return a
> different score each time it is asked.
>
> **On identity:** automated identity match is live — `face-cpu` (InsightFace **buffalo_s**:
> SCRFD-500MF detector + ArcFace MobileFaceNet recognizer, both ONNX, CPU-only via onnxruntime) —
> built, tested and verified live on 2026-08-06 (known-person matches scored 0.85 and 0.79 against
> a provisional `ACCESS_MATCH_THRESHOLD=0.43`). The Modulino Distance sensor detects presence
> (under 1000mm) and opens a challenge; a photo is captured and matched against the roster.
> Enrolled people resolve automatically; **an unmatched face still falls to a human** — approve or
> deny on the phone, or from the wall dashboard's approval panel, which now shows the captured
> photo (held in memory only, never written to disk, dropped the moment a decision lands). There
> is **no liveness detection** — a printed photo of an enrolled face could pass — which is exactly
> why every non-match still requires a human decision and the demo stays human-supervised.
> Presence, door state, the decision matrix and the approval loop are all real and live. The
> codebase has a pluggable identity-adapter interface (`qr-badge`, `face-npu`, `face-cpu`) behind
> this; `qr-badge` and the NPU-accelerated `face-npu` rung are not built or claimed — see
> [phone/README.md](phone/README.md) § the identity ladder. InsightFace's pretrained models are
> released for **non-commercial research purposes only**.

## Status
**[PROGRESS.md](PROGRESS.md)** — the living done/next map. Read this first.
**[docs/POSITIONING.md](docs/POSITIONING.md)** — the approved wording: pitch, offline claim, Q&A answers.
**[SUBMISSION.md](SUBMISSION.md)** — every hackathon submission requirement, checked off or flagged.
**[docs/EVIDENCE.md](docs/EVIDENCE.md)** — every measured claim with the measurement behind it.

## Today vs. planned

Everything in the left column is built and verified on this rig; everything in the right
column is **designed but NOT built**. The two columns are kept side by side on purpose: unbacked
claims score zero, so the line between them is part of the submission, not a footnote.

| Area | Today (built, verified) | Planned (not built) |
|---|---|---|
| LLM inference | Qwen3-4B-Instruct-2507 Q4_0 on the **laptop's** X Elite NPU via GenieX — measured, serving the agent. **Same model measured on the phone's 8 Elite NPU** (2026-08-06): pre-compiled AI Hub bundle (w4a16, ctx 4096) via `genie-t2t-run` over `adb` — **prefill 1,918 ± 16.9 tok/s, decode 23.1 ± 1.3** — two Hexagon NPUs, one table, every config delta labeled ([RESULTS.md § Phone benchmark](llm-serving-bench/RESULTS.md#phone-benchmark-snapdragon-8-elite--2026-08-06)). **And the failover brain is wired** (verified live 2026-08-06): a dead GenieX — TCP connect refused, never an HTTP probe — routes the Telegram question to the phone over `adb`, answer delivered to Telegram + wall labeled degraded, **12.0 s** message→delivered ([hermes-hooks/README.md](hermes-hooks/README.md)) | On-phone **serving** (a persistent endpoint — the failover path is a one-shot CLI run per question) |
| Physical access | Presence (ToF distance sensor, <1000mm) → challenge → photo captured → **automated identity match on CPU** (`face-cpu`: InsightFace buffalo_s, SCRFD-500MF + MobileFaceNet, onnxruntime) resolves enrolled people — built and verified live 2026-08-06, known matches scored 0.85/0.79 against a provisional threshold. Unknown faces still go to a human: approve/deny on the phone's local page, or the wall's approval panel (now shows the captured photo) → append-only audit trail | NPU-accelerated identity (`face-npu` — same models, Hexagon NPU execution) and `qr-badge` — **not** built |
| Phone's role | Approval terminal (`phone.html`) + Telegram client + **challenge notification pushed to Telegram** (text only, deliberately no photo; fire-and-forget, silent no-op when unconfigured) — **plus the failover brain** (built + verified live 2026-08-06): kill the laptop's GenieX and the phone's 8 Elite NPU answers the Telegram question over `adb`, labeled *📱 phone-NPU failover — degraded mode, no tools*. Compute failover, **not** an offline claim — Telegram still needs internet ([hermes-hooks/README.md](hermes-hooks/README.md)). The bench bundle is re-staged on the phone as a demo dependency (USB debugging on, Auto Blocker off through Friday); the phone stayed a working approval terminal throughout | On-phone **serving** on the 8 Elite — a persistent endpoint; today's failover is one-shot, no tools |
| Alert suppression | **Wired and verified end to end**: an enrolled responder on site withholds the page; walking away releases it *("held while the on-call was on site; sending now")*; escalation or a stale access state pages regardless | — |
| Energy | **Measured 2026-08-05** (HWiNFO system-rail integration, 60s idle baseline subtracted, same method as arXiv 2606.11257): NPU **471 J/query** at the real 12.5K-token agent shape (n=5); CPU burns **~8.7× more energy per prompt-token** (0.327 vs 0.0375 J) and lifts the system +21.3 W over idle vs the NPU's +6.3 W — [llm-serving-bench/RESULTS.md](llm-serving-bench/RESULTS.md#energy--joules-per-query-measured-2026-08-05-pm) | Same measurement on the **phone's** 8 Elite NPU, with error bars |
| On-board activity inference | **SmolLM2-135M runs on the UNO Q itself** (CPU — the board's Adreno 702 GPU was found, measured and rejected: ~32× slower decode), correlating recent sensor history into `activity-*` log lines. A fresh line reaches the wall's device feed as an **"AI:" row** and is folded into the watchdog's Telegram page — built + verified 2026-08-06 ([docs/ONDEVICE_ACTIVITY.md](docs/ONDEVICE_ACTIVITY.md)) | Feeding `activity-*` lines into `get_incident_assessment` so the 4B tier reasons over the board's inferences — left unwired for the demo **on purpose** (a new assessment input two days out is churn risk; every detection already reaches the humans); level-based leak threshold demoted (Button C is the trigger) |

## Quickstart — three rungs, pick your hardware

The fastest path to seeing something real. Rung 1 needs any machine with Node 22+; the
higher rungs need specific hardware. Every step says what "worked" looks like.

**Rung 1 — code, tests, and the wall display (any OS/arch, ~5 minutes, no hardware):**

```powershell
cd mcp-tools
npm install
npm run build
npm test                       # expect: Test Files 30 passed (30), Tests 361 passed (361)
npm run start:dashboard        # then open http://127.0.0.1:7788
```

Expected: the wall renders live, with a header pill reading **"Sensor feed down ·
environmental reading is mock"** — that is the system saying honestly that no live sensor
board is attached (the checked-in sensor log is stale, so readings fall back to labeled
mock). Open `http://127.0.0.1:7788/phone.html` in a second tab for the phone's approval
surface. Everything simulated on screen is labeled as such.

**Rung 2 — the offline agent on the NPU (needs a Snapdragon X Elite laptop):** follow
[§0. Setting this up on a fresh machine](#0-setting-this-up-on-a-fresh-machine) — steps 1–5,
~30 min plus ~10 GB of model downloads — then:

```powershell
hermes -z "assess the current incident"   # one-shot; expect ~2–4 min (full NPU prefill)
```

Expected: a verdict with tool-derived numbers (latency, temperature, risk arithmetic). This
rung works with WiFi off — model, agent, and tools are all local.

**Rung 3 — the full demo rig (laptop + UNO Q board + phone):** steps 1–7 of the section
below, in start order.

**Fallback modes, all deliberate:** no Snapdragon → everything runs except NPU inference
(x64 CPU verified); no Telegram token → paging is a silent no-op and the health endpoints
say so; no sensor board → environmental readings are labeled mock and never move the alert
state machine.

**Benchmark evidence:** [docs/EVIDENCE.md](docs/EVIDENCE.md) indexes every measured claim —
NPU vs CPU throughput ([llm-serving-bench/RESULTS.md](llm-serving-bench/RESULTS.md)),
joules-per-query, per-op Hexagon profiling ([docs/BENCHMARKS.md](docs/BENCHMARKS.md)).
Test suite: **30 files / 361 tests, all passing** (verified 2026-08-07).

## Run it yourself — the whole flow, in start order

The stack is seven pieces. Start them in this order; each step says what it is, the exact command,
and how to know it worked. The flow being started:

```
[1] GenieX model server (NPU)  ←  [3] Hermes Agent  →  [4] Telegram gateway → phone
                                        ↑ stdio (automatic)
                                  [MCP tool servers: network/storage/compute = mock,
                                   environmental = real, assessment = the one-call verdict]
                                        ↑ log file
                                  [2] Arduino UNO Q sensors + on-board activity LLM → WiFi + Tailscale VPN
                                  [5] watchdog loop (15s) → proactive Telegram alerts
                                  [6] wall display     → local browser (read-only)
                                  [7] access terminal  → the phone (the only thing that writes)
```

Steps 6 and 7 are the **same server** on port 7788 — one page for the demo table, one for the
phone.

### 0. Setting this up on a fresh machine

Already provisioned on the demo laptop — skip to step 1 there. These are the reproducible steps
for anywhere else.

**Prerequisites**

| Need | Note |
|---|---|
| **Windows on ARM64** (Snapdragon X Elite / Copilot+) | The GenieX NPU path is win-arm64 only. An x64 machine can run everything *except* NPU inference |
| **Node 22+** | For the MCP tool servers (`package.json` engines floor is 22; the dashboard's optional transcript bridge wants 22.5+ for `node:sqlite` and degrades gracefully below it; verified on v24.18) |
| **`adb`** | Only for flashing/configuring the board (sketch + app deploy, initial WiFi/Tailscale setup, clock sync) — it carries no sensor traffic. Ships inside the scrcpy package: `winget install Genymobile.scrcpy` — this is not obvious |
| **Telegram bot token** | From [@BotFather](https://t.me/BotFather); your numeric id from @userinfobot |
| QAIRT SDK 2.32+ *(optional)* | Only to re-run the NPU profiling in `bench/` |
| ~10 GB disk | Model artifacts: Q4_0 GGUF ~4.5 GB, W4A16 bundle ~3 GB |

**Install, in order**

```powershell
# 1. GenieX + the model. Q4_0 is load-bearing: Q4_K_M silently falls back to CPU.
#    Preview installer → %LOCALAPPDATA%\GenieX CLI\geniex.exe. Pin CLI v0.3.18 — the
#    version every number in this repo was measured against. The preview channel moves
#    weekly, and the phone/bench stack borrows its QAIRT 2.45 backend libs
#    (PROGRESS.md), so upgrading breaks more than this README.
& "$env:LOCALAPPDATA\GenieX CLI\geniex.exe" pull unsloth/Qwen3-4B-Instruct-2507-GGUF
& "$env:LOCALAPPDATA\GenieX CLI\geniex.exe" ls          # expect the Q4_0 precision listed

# 2. MCP tool servers
cd mcp-tools; npm install; npm run build; npm test      # expect 361/361 passing
cd ..

# 3. Hermes Agent — install.ps1 comes from the hermes-agent release page
#    (https://github.com/NousResearch/hermes-agent, MIT), NOT from this repo. Native
#    ARM64; wants Node 26 for itself (this repo's own floor stays Node 22) — that
#    requirement landed 2026-08-02, so pin the release you installed rather than
#    tracking latest. Lands in %LOCALAPPDATA%\hermes\  (this is HERMES_HOME; there is
#    NO ~/.hermes on Windows.)
.\install.ps1                                            # downloaded from the release above

# 4. Secrets — the installer ships a stock .env at %LOCALAPPDATA%\hermes\.env full of
#    commented cloud keys you should keep. APPEND the template (a plain copy would
#    clobber that stock file), then edit in your token + user id:
Get-Content hermes.env.example | Add-Content "$env:LOCALAPPDATA\hermes\.env"

# 4b. The non-streaming patch — REQUIRED, or Hermes retries every completed reply
#     forever (GenieX streams end without a finish frame). The diff is committed:
.\hermes-hooks\patches\apply-nonstream.ps1               # idempotent; pairs with HERMES_FORCE_NONSTREAM=1 from the template
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
      # UNOQ_LEAK_DISTANCE_MM: "150"      # water-level threshold - currently INERT (see uno-q/README); Button C is the leak trigger
  assessment:                             # get_incident_assessment - one call, one verdict
    command: node
    args: [ "<REPO>\\mcp-tools\\dist\\servers\\assessment-server.js" ]
    env:
      UNOQ_SENSOR_LOG: "<REPO>\\arduino_uno_q-sensor_log.json"
      UNOQ_LOG_MAX_AGE_S: "180"           # it reads the sensor path too - keep these in sync

tools:
  tool_search:
    enabled: "off"                        # Qwen3-4B never completes the tool_search →
                                          # tool_describe → tool_call discovery dance; with
                                          # search on it answers from memory and calls no
                                          # tools. "off" inlines the schemas (troubleshooting)
```

⚠️ **Register `assessment` — it is easy to miss and it is the one that matters on stage.** Each
agent turn costs a full prompt re-prefill on the NPU (2–4 min), so a four-status-call answer is a
ten-minute answer. `get_incident_assessment` does all four families plus the risk and confidence
arithmetic in one call. Confirm it is live with `hermes -z "assess the current incident"`. If the
laptop's existing `config.yaml` only lists four servers, this is the missing one.

**6. Proactive alert watchdog** — a persistent 15s loop, not a cron job (see
[docs/WATCHDOG.md](docs/WATCHDOG.md)):

```powershell
cd mcp-tools; npm run build; cd ..
.\scripts\install-autostart.ps1 -Only watch      # Scheduled Task SMH-Hermes-Watchdog
curl.exe -s http://127.0.0.1:7789/health         # ticks climbing, canDeliver true
```

It needs `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in its environment to page; without them it
still ticks and persists, and says so on the health endpoint and the wall.

<details><summary>Legacy: the same watchdog as a Hermes cron job</summary>

```powershell
copy mcp-tools\cron\environmental-watch.py "$env:LOCALAPPDATA\hermes\scripts\"
hermes cron create --schedule "every 1m" --name "Environmental watch" `
  --script environmental-watch.py --no-agent --deliver telegram
```

Shares the same tick code, but fires every ~2 minutes no matter what schedule it is given
(measured 120s × 415 executions at `every 1m`). **Run one watchdog, not both** — both persist
`.state/environmental-watch.json`, so two means every page arrives twice.

*Status on the demo laptop (2026-08-07): the Scheduled-Task loop `SMH-Hermes-Watchdog` is the
live alerting path; this cron variant is retired there and kept only as the documented fallback.*
</details>

**7. UNO Q app** — deploy `uno-q/hermes-sensor-logger/` to the board (see
[uno-q/README.md](uno-q/README.md)); it auto-starts via systemd.

#### Paths to change when moving machines

Every absolute path lives in exactly five places — grep for `C:\Users\qc_de` to find them all:

| Where | What |
|---|---|
| `%LOCALAPPDATA%\hermes\config.yaml` | 5 × `mcp_servers` args + 2 × `UNOQ_SENSOR_LOG` |
| `%LOCALAPPDATA%\hermes\scripts\environmental-watch.py` | `REPO_ROOT` (or set `SMH_HERMES_ROOT` instead of editing) |
| `bench/bench.py` | `SDK`, `GX`, `BUNDLE` constants — only if profiling |
| `llm-serving-bench/bench.py` + `run_cpu_energy.py` | `GENIEX` exe path, HWiNFO CSV path — only if re-running the serving bench |
| `docs/` | Illustrative paths in prose; harmless if left |

### 1. Model server — GenieX on the Hexagon NPU

**Preferred — under the supervisor** (GenieX has been observed exiting silently under load;
see the last troubleshooting row). It starts GenieX with the correct flags, restarts it when
it dies, and warns if `--nctx` and `config.yaml` disagree:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\geniex-supervisor.ps1
```

Or by hand, which is the same command it runs:

```powershell
& "$env:LOCALAPPDATA\GenieX CLI\geniex.exe" serve --nctx 65536 --compute npu --keepalive 3600
```

Serves an OpenAI-compatible endpoint at `http://127.0.0.1:18181/v1`. First request after start
takes ~30s (model load). **Worked when:** a `geniex` process exists *and* something is
listening —

```powershell
Get-Process geniex; Get-NetTCPConnection -LocalPort 18181 -State Listen
```

⚠️ **Do not health-check with `curl /v1/models` except on a cold start.** GenieX serializes
every request behind a global lock, so that call — **654 µs** when idle — took **1m42s**
while a completion was in flight. An HTTP probe cannot distinguish *busy* from *dead*.
Process + socket stays correct while the model is thinking.

Why these flags:

- **`--nctx 65536`** — Hermes hard-requires 64K. This **must equal `context_length` in
  `config.yaml`**: Hermes builds prompts up to its declared context, so if GenieX allocated
  less, the overflow lands on the server. (The default is 4096, nowhere near enough.)
- **`--compute npu`** — offloads to Hexagon; measured **12–17% CPU** during NPU generation vs
  **33%+** on the benchmarked Q4_0 CPU run and 56–74% under the Q4_K_M silent CPU fallback
  ([docs/NPU_SPIKE_RESULTS.md](docs/NPU_SPIKE_RESULTS.md)). Leaving it
  unset auto-selects, and did pick NPU on this laptop — set it anyway, auto-selection is not a
  contract. Don't use `--compute gpu`: faster prefill, but reproducibly fails tool-enabled
  requests (GenieX preview bug).
- **`--keepalive 3600`** — the default is **300**, which unloads the model after 5 minutes
  idle. The watchdog loop never touches the model, so nothing keeps it
  warm: every Telegram message after a quiet spell pays a full model reload *before* prefill.
  This is the single largest avoidable chunk of "first reply takes minutes".

Every flag also has an env var — `GENIEX_NCTX`, `GENIEX_COMPUTE`, `GENIEX_KEEPALIVE`,
`GENIEX_HOST`, `GENIEX_NGL`, `GENIEX_DATADIR`. There is **no `--model` flag**: the model is
chosen per request by the API call's `model` field, resolved against
`%USERPROFILE%\.cache\geniex\models\`.

Restart, recovery and health checks for every component: **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

### 2. Sensors — Arduino UNO Q → laptop log file

The board app auto-starts on boot and writes one `sensor_tick` line (temperature + humidity) every
10s to its local log, plus one line per button transition — both press *and* release — and one per
ToF presence crossing. Since 2026-08-06 the board's own SmolLM2-135M adds an `activity-*` line
when it infers something from the recent history ([docs/ONDEVICE_ACTIVITY.md](docs/ONDEVICE_ACTIVITY.md)). Getting that file **to the laptop** is WiFi + Tailscale, and nothing else:
nothing to start on the laptop — the board's `hermes-sensor-logger-push.service` scp-pushes every
10s over the tailnet, *if* the board has WiFi and its Tailscale is authed (`tailscale status` on
the board; re-auth after long offline periods).

**USB-C is configuration only** — flashing the board app, initial WiFi/Tailscale provisioning, and
one-off admin commands like the clock sync below. It never carries sensor data to the server.

⏱️ **Budget ~70 seconds from power-on.** Boot is ~1min 9s measured, and most of that is the board
waiting for NTP before it starts Tailscale — deliberate, so the VPN never comes up on a 1970 clock.
Power the board up before you need it, not during the demo. Detail and the measured numbers:
[uno-q/hermes-sensor-logger/README.md](uno-q/hermes-sensor-logger/README.md#boot-sequence-and-timing).

⚠️ **After a board power-up with no NTP at all** (offline bench, captive portal): the UNO Q has no
RTC battery — it boots in 1970, all timestamps go wrong, and the staleness guard will (correctly)
reject its data. On a network with working NTP the boot sequence now fixes this by itself. When it
can't, set the clock from the laptop over USB:
```powershell
$utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss")
adb shell "docker run --rm --user 0 --cap-add SYS_TIME --entrypoint date ghcr.io/arduino/app-bricks/python-apps-base:0.5.0 -u -s '$utc'"
```

📏 **The log holds raw floats; everything sent is one decimal.** A tick reads
`"temperature_c": 25.081483840942383` on disk and reaches the phone as `25.1C`. The cut happens once
on the laptop, at ingestion, so the agent, the alert threshold, the Telegram text and the wall
display all quote the same number —
[mcp-tools/README.md](mcp-tools/README.md#one-decimal-place-applied-on-the-way-in).

**Worked when:** `arduino_uno_q-sensor_log.json` at the repo root gets a fresh `sensor_tick` line
every ~10–20s. (The file is runtime output from the board's push pipeline — not tracked in git;
it appears once the board pushes, and every reader degrades to labeled mock data until then.)
If you edited the board app, redeploy over USB:
```powershell
adb push uno-q\hermes-sensor-logger\sketch\sketch.ino /home/arduino/ArduinoApps/hermes-sensor-logger/sketch/sketch.ino
adb push uno-q\hermes-sensor-logger\python\main.py /home/arduino/ArduinoApps/hermes-sensor-logger/python/main.py
adb shell "arduino-app-cli app restart user:hermes-sensor-logger"    # no sudo needed, ~1 min
```
From a macOS/Linux dev machine (same commands, forward slashes):
```bash
adb push uno-q/hermes-sensor-logger/sketch/sketch.ino /home/arduino/ArduinoApps/hermes-sensor-logger/sketch/sketch.ino
adb push uno-q/hermes-sensor-logger/python/main.py /home/arduino/ArduinoApps/hermes-sensor-logger/python/main.py
adb shell "arduino-app-cli app restart user:hermes-sensor-logger"
```

### MCP tool servers — nothing to start

Hermes spawns all five (`network`, `storage`, `compute` — realistic mocks — `environmental` —
real, reading the sensor log — and `assessment`, the one-call verdict) automatically over stdio; they're registered in Hermes's
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
the network mock). Expect ~2–4 min per tool-calling turn (every model call re-prefills the full prompt — measured
382 tok/s at the bench shape, ~206 tok/s at the real 12.5K agent shape) — keep demo questions
to one tool call each. This step is the **offline demo beat**: it
works with WiFi off, because model, agent, and tools are all local.

### 4. The phone — Telegram gateway

```powershell
hermes gateway start      # background service (stop / restart / status also available)
hermes gateway status     # expect: running, telegram connected

# Message receipts — install once, and again after any `hermes update`
powershell -ExecutionPolicy Bypass -File scripts\install-hermes-hooks.ps1
```

**Worked when:** messaging the bot from the allowlisted phone gets **two** replies — an italic
receipt within a couple of seconds, then the answer (2–4 min for tool-calling questions). Note:
Telegram is the one cloud hop in the system — it relays chat text only; the LLM never leaves the
laptop.

A turn takes 60–300 s and Hermes runs non-streaming here, so without the receipt the phone shows
nothing at all in that window — the same silence whether the gateway is thinking, wedged, or
dead. Telegram's `typing…` bubble doesn't fix that: it expires between refreshes and never
reaches the notification shade. So the gateway answers twice:

```
> what's the temperature in rack B1?
  Pulling the temperature data from rack B1 now — about a minute.     (~2 s, italic)
  Rack B1 is 22.4 °C, humidity 41%, source: real (sensor age 12 s).   (~60 s, plain)
```

The receipt is one line from the same local model — it names what you asked, and carries a wait
estimate learned from that session's own measured turns. It is generated **before** the agent's
first model call, because GenieX serializes requests and a receipt generated afterwards would
queue behind the answer it announces; that costs the turn ~2.3 s. It reports no findings ever
(nothing has been looked up yet), and if the model is down or slow it still goes out, canned,
with the estimate. Design, configuration and limits:
[hermes-hooks/README.md](hermes-hooks/README.md).

### 5. Proactive alerts — the watchdog loop

A persistent process ticking every **15s** (`curl.exe -s http://127.0.0.1:7789/health` to confirm)
with **zero LLM cost per tick**, pushing to Telegram only on a threshold crossing or recovery —
silence is the normal state. The pages carry the board's AI too: a fresh `activity-*` inference
is appended to the alert text (*"UNO Q detected a possible activity: …"*), and deliberately does
**not** pass through suppression — a responder at the rack is a reason to hold a threshold page,
not to hold "someone just entered the room". To exercise it end to end:

1. Press and **hold** button C on the UNO Q (press logs `leak_detected`; releasing logs
   `leak_cleared`, which cancels the alert rather than re-raising it). The water-level path is not
   currently reachable — see the warning in [uno-q/README.md](uno-q/README.md).
2. **ALERT on the phone within ~15–30s** — the board pushes on a ~10s loop, and the watchdog picks
   it up on the next tick.
3. A one-time "recovered to OK" push once it clears — that's edge-triggered recovery working, not
   a bug.

Measured sensor-edge-to-phone: **14.2s** on a lucky press, **102.2s** on an unlucky one, back when
this ran on `hermes cron`. The wait for the next tick was ~86% of that worst case, which is the
whole reason the loop exists — [docs/WATCHDOG.md](docs/WATCHDOG.md) has the full budget.

⚠️ **The watchdog can now stay silent on purpose.** If an enrolled person is standing at the rack
while an incident is live (step 7), the page is **withheld** — you are looking at the thing it
would have told you about. It is a deferral, not a cancellation: walk away and the alert arrives
marked *"held while the on-call was on site; sending now."* Escalation while you stand there pages
anyway — and says so differently, *"escalated while the on-call was on site — paging anyway"*, so a
rack that got worse under your nose is never mistaken for a deferred page arriving late. If the
wall isn't running the state goes stale and it pages regardless. So "no alert"
has two causes now — nothing wrong, or someone is on site. The wall says which.

### 6. The wall display — one page showing all of the above

A local web page for the demo table: the UNO Q and its door / lighting / leak / temperature /
humidity state on the left — its device feed labels the board's own SmolLM2 inferences as
**"AI:" rows** — the server ingesting that feed alongside the network, storage and
compute telemetry — and the inference it draws from them — in the middle, and the phone's Telegram
thread on the right, **both directions** — pages the server sent on the left rail, questions the
phone sent on the right. Three static tabs sit alongside the live one: the executive overview, the
conceptual architecture (what the parts are) and the logical architecture (what moves, stage by
stage). Screenshots of every tab (captured 2026-08-06) live in
[docs/evidence/wall/](docs/evidence/wall/) — dashboard UI shots, distinct from the benchmark
captures indexed in [docs/EVIDENCE.md](docs/EVIDENCE.md).

```powershell
cd mcp-tools
npm run start:dashboard          # then open http://127.0.0.1:7788 in Edge on this laptop
cd ..
```

**Worked when:** the header tick counter climbs, the `live` dot is green, and the left column grows
a `climate tick` line every ~10s. A header pill reading **"Sensor feed down · environmental reading
is mock"** means the display is working and telling you the truth — the sensor path is not
delivering, and the Ingest card carries the reason string.

It reads the same functions the MCP tools call, so it cannot disagree with the agent; it never
writes anything; and it is loopback-only, so it works with the WiFi off. Set
`UNOQ_LOG_MAX_AGE_S=180` here too, to match the environmental server's env block — otherwise the
agent falls back to mock while the wall still shows a live feed.

The phone thread is real traffic in both directions with nothing to configure: the wall opens
Hermes's own transcript (`%LOCALAPPDATA%\hermes\state.db`) **read-only** and mirrors it. It does not
poll Telegram — `hermes gateway` is the single allowed consumer of that bot token, and a second
poller would starve the agent of the very questions it exists to answer. Full reference:
**[docs/DASHBOARD.md](docs/DASHBOARD.md)**.

### 7. The access terminal — the phone

Same server as step 6, different page. This is the **only part of the system a human writes to**:
it is where an access challenge is answered.

```powershell
# Bind somewhere the phone can reach — the Tailscale address, never 0.0.0.0 on venue WiFi.
$env:DASHBOARD_HOST      = "100.x.y.z"     # the laptop's tailnet address
$env:ACCESS_SHARED_SECRET = "pick-something"
cd mcp-tools; npm run start:dashboard; cd ..    # ACCESS_IDENTITY_METHOD defaults to "stub"
```

Then open `http://100.x.y.z:7788/phone.html?secret=pick-something` on the phone.

Lost the link, or a phone that used to work now says *Capture rejected*? Don't reconstruct it by
hand — `scripts\show-phone-link.ps1` prints the URL with the key already appended,
copies it to the clipboard, and **checks the key against the running server** before telling you
it is good (exit 0 = accepted, 2 = rejected). A stale key is the failure worth naming: the page
looks completely normal and only fails at the moment of capture, so it reads as a broken camera.

What it does: someone approaches the rack, the ToF presence sensor (< 1000mm) opens a
**challenge**, you photograph them with one tap, identity resolves down a pluggable ladder, and an
8-row decision matrix produces a verdict in context — including **tailgating** (more faces than
authorised door entries) and **anti-passback** (at the rack with no door edge). `ACCESS_IDENTITY_METHOD`
defaults to `stub` (detection-only, the safe default for an unconfigured clone); switch on
`face-cpu` (see [Face recognition (face-cpu)](#face-recognition-face-cpu) below) and an enrolled
person resolves automatically — built and verified live 2026-08-06. An unmatched face still needs
a human: approve or deny **on this page**, or from the wall's approval panel, which shows the
captured photo. (`qr-badge` has no real badge behind it, just a typed name treated as a credential;
the NPU-accelerated `face-npu` rung is not built — see
[phone/README.md](phone/README.md#the-identity-ladder). Neither is claimed.)

**Worked when:** trip the ToF sensor → the wall's Access card reads *"Presence detected — awaiting
capture"* → tap the camera button on the phone → the verdict and reasons appear on **both** screens
within a second → Approve → the wall shows who allowed it, and the audit trail gains one row when
the person leaves.

Three things it deliberately refuses to do:

- **An unobserved door is not a closed door** — `doorConsistent` is true, false, or absent.
- **A decision does not rewrite the finding.** Approving a `tailgating` event relaxes the severity
  and records who allowed it; the verdict still reads `tailgating`. A *denial does not quiet the
  alarm*.
- **A dead sensor feed freezes the loop rather than guessing.** No challenge is opened and none is
  filed as abandoned, because the board dying is not the same event as a person leaving.

**Privacy — the point of doing this on-device:** a matched capture is resolved to a numeric
embedding and the image is discarded. `mcp-tools/.state/roster.json` holds floats only; you cannot
reconstruct a face from it, and it is safe to open on stage. An **unmatched** capture is held in
memory only — never written to disk — so the wall's approval panel can show it to the human making
the call, and it is dropped the instant a decision lands or the challenge is abandoned.
`.gitignore` blocked `*.jpg`, `roster.json` and `.state/` **before the first capture existed**.
There is **no liveness detection** — a printed photo of an enrolled face could pass a match — which
is exactly why every non-match still requires a human decision and the demo stays
human-supervised. InsightFace's pretrained models (used by `face-cpu`) are released for
**non-commercial research purposes only**. Full reference: **[phone/README.md](phone/README.md)**.

### Face recognition (face-cpu)

Optional, off by default (`ACCESS_IDENTITY_METHOD` defaults to `stub`). Built, tested and verified
**live** 2026-08-06 — CPU inference on the laptop, deliberately not NPU: Phase A targets something
deterministic and stable inside a 24-hour ship window, not maximum throughput. The `face-npu` rung
is architected for the same models on the Hexagon NPU but is **not built**.

**1. Fetch the models** — the InsightFace **buffalo_s** bundle: SCRFD-500MF detector
(`det_500m.onnx`) + ArcFace MobileFaceNet recognizer (`w600k_mbf.onnx`), both ONNX, from the
InsightFace model zoo (<https://github.com/deepinsight/insightface> — buffalo_s release package).
**InsightFace's pretrained models are released for non-commercial research purposes only.** Place
both files at `mcp-tools/models/buffalo_s/` and confirm the hashes match:

| File | SHA256 |
|---|---|
| `det_500m.onnx` | `5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a` |
| `w600k_mbf.onnx` | `9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f` |

```powershell
Get-FileHash mcp-tools\models\buffalo_s\det_500m.onnx -Algorithm SHA256
Get-FileHash mcp-tools\models\buffalo_s\w600k_mbf.onnx -Algorithm SHA256
```

**2. Install the Python environment** — Python 3.11, pinned versions in
[`mcp-tools/requirements-face.txt`](mcp-tools/requirements-face.txt) (the measured 0.43
threshold below was calibrated under exactly these). The venv lives **next to** the checkout —
that is where the demo kill-switch scripts look for it:

```powershell
python -m venv ..\.venv-face
..\.venv-face\Scripts\pip install -r mcp-tools\requirements-face.txt
```

**3. Enroll people** — offline, from photo files, via `mcp-tools/scripts/enroll.py` (the phone
page's own "enrol" form stays disabled for the demo):

```powershell
python mcp-tools\scripts\enroll.py --name "<Name>" --dir path\to\photos
```

Per-photo embeddings are L2-normalized, averaged, then re-normalized into one roster entry in
`mcp-tools/.state/roster.json`. `mcp-tools/scripts/probe.py` is the standalone tool used to check
genuine-vs-impostor separation before picking a threshold.

**4. Set the match threshold** — `ACCESS_MATCH_THRESHOLD` (cosine similarity). The current value,
**0.43, is provisional**: measured 2026-08-06 on a 3-person roster enrolled from laptop-webcam
photos (genuine n=23, min cosine 0.7702; impostor n=46, max cosine 0.1026; threshold = the midpoint
rounded down), then validated live the same day against phone-camera captures — known-person
matches scored **0.85** and **0.79**. Small n — re-measure for any larger roster.

**5. Turn it on or off** — kill switches, ~5s, both live-tested 2026-08-06:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\demo-face-ON.ps1    # ACCESS_IDENTITY_METHOD=face-cpu
powershell -ExecutionPolicy Bypass -File scripts\demo-face-OFF.ps1   # back to stub (safe default)
```

Both set process-scope env only, so nothing persists past the restarted dashboard process.

**No liveness detection.** A printed photo of an enrolled face could pass a match. Mitigation:
every non-match still falls to a human — approve/deny on the phone, or from the wall's approval
panel, which shows the captured photo (held in memory only, never written to disk, dropped the
moment a decision lands) — the demo is human-supervised throughout.

### Quick health check, all seven

```powershell
Get-Process geniex; Get-NetTCPConnection -LocalPort 18181 -State Listen  # [1] model server up
                                                                  #     (NOT curl -- it queues behind inference)
Get-Item arduino_uno_q-sensor_log.json | % LastWriteTime          # [2] fresh = sensors flowing
Select-String '"event": "activity"' arduino_uno_q-sensor_log.json |
    Select-Object -Last 1                                         # [2b] board AI has inferred
                                                                  #     (edge-triggered - may be old)
node mcp-tools\dist\alert-skill\check-environmental.js --json     # [tools] source: real
hermes -z "what's the temperature in rack B1?"                    # [3] agent + tools + NPU
hermes gateway status                                             # [4] telegram connected
& "$env:LOCALAPPDATA\hermes\hermes-agent\venv\Scripts\python.exe" `
    hermes-hooks\ack\handler.py --try "is rack B1 hot?"           # [4] receipts work + geniex
                                                                  #     answers (a request it
                                                                  #     serves, unlike a probe)
curl.exe -s http://127.0.0.1:7789/health                          # [5] watchdog ticking
curl.exe -s http://127.0.0.1:7788/api/health                      # [6] wall display up, feed state
curl.exe -s http://127.0.0.1:7788/api/access/state                # [7] access verdict + roster
```

## Troubleshooting — symptom → cause

Every row here cost us real time; none are hypothetical.

| Symptom | Cause | Fix |
|---|---|---|
| Telegram **questions** fail — *"model provider failed after retries"*; log shows `APIConnectionError … 127.0.0.1:18181` | **GenieX isn't running.** Nothing auto-starts it after a reboot | Redo step 1. Note the **watchdog alerts keep arriving while this is broken** — they never call the model, so "alerts are fine" is *not* evidence the agent is fine |
| Replies never finalize; Hermes retries forever | The non-streaming patch was reverted — usually by `hermes update` | Re-apply the patch and keep `HERMES_FORCE_NONSTREAM=1` |
| **No receipt arrives** — the phone is silent until the answer | The ack hook isn't loaded. Hooks are discovered at gateway **startup only**, and `hermes update` rewrites `HERMES_HOME` | `Select-String "Loaded hook 'ack'" "$env:LOCALAPPDATA\hermes\logs\gateway-stdio.log"`. Missing → re-run `scripts\install-hermes-hooks.ps1` |
| A receipt arrives but the answer never does | Working as intended, and now visible: the receipt is sent before the model call, so it proves the gateway heard you and the *model* is what failed | Check GenieX (row 1). The receipt narrows "did it hear me?" to "it heard me and couldn't answer" |
| Receipts are canned (*"Message received, work started"*) every time | The model call behind them is failing or timing out — usually GenieX down, or a reload taking longer than `HERMES_ACK_TIMEOUT_S` | `hermes-hooks\ack\handler.py --try "..."` prints the real error and the latency |
| The wait estimate is obviously wrong | It is learned from that session's last five turns; a fresh session starts from the measured priors and needs a turn or two to converge | Nothing to fix. `%LOCALAPPDATA%\hermes\state\ack-hook.json` shows what it has measured |
| `"source": "mock"`, reason *"sensor log is stale"* | Board clock is wrong. The UNO Q has **no RTC battery**, so a power-up with no reachable NTP resumes hours behind and its timestamps look ancient | On a network with NTP the boot sequence fixes this itself — just wait ~70s. With no NTP, set the clock over USB — step 2 ⚠️ |
| Board takes over a minute to appear after power-on | Expected. Boot waits for NTP before starting Tailscale (~38s of a ~69s boot) so the VPN never comes up on a 1970 clock | Nothing to fix — budget ~70s. See [boot timing](uno-q/hermes-sensor-logger/README.md#boot-sequence-and-timing) |
| An alert arrives with plausible-but-invented numbers | Same as above. The mock fallback labels itself honestly, but the *severity* still reads as real | Check `source` before trusting any alert. `mock` = the physical path is down |
| Model answers but `tool_calls` is `null` | Wrong quantization — Q4_K_M | Use **Q4_0** |
| `SDKError(Model loading failed)` on tool-enabled requests | `--compute gpu` | Use `--compute npu` |
| Cron job fails every tick: `WSL (9 - Relay) … execvpe(/bin/bash) failed` | The job points at a `.sh`. Hermes picks the interpreter by **file extension**; `bash` here resolves only to WSL launchers, whose default distro has no `/bin/bash` | Use the `.py` wrapper (`--script environmental-watch.py`) |
| Cron passes when run by hand, fails on schedule | You verified a path the runtime doesn't use | Verify via a **real tick** — `last_status` in `cron\jobs.json` — never a one-off run |
| Priming the alert state changes nothing | PowerShell 5.1 `Set-Content -Encoding utf8` writes a **BOM**; `JSON.parse` fails and `readState` silently defaults to `ok` | `[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))` |
| `geniex` / `hermes` "not recognized" | Neither is on every shell's PATH | Use the full path, or `Set-Alias` (step 3) |
| `adb` not found | It ships inside the scrcpy package | `winget install Genymobile.scrcpy` |
| **No alert arrived and nothing is wrong on the wall either** | An enrolled person is at the rack, so the page is being **held** on purpose (step 5 ⚠️) | Check the Access card — verdict `expected` means held, not broken. Walk away from the sensor and it fires |
| The wall shows `expected` but the phone still paged | Correct: either the status **escalated** after they arrived, or the access state is older than `ACCESS_SUPPRESS_MAX_AGE_S` | Both are fail-open by design. If it is staleness, the dashboard (step 6) is not running — suppression needs it alive |
| Phone gets **401** on Approve / Enrol | `ACCESS_SHARED_SECRET` is set on the server but missing from the phone's URL | Open `…/phone.html?secret=<the secret>` |
| Phone page looks **completely normal**, then "Capture rejected" the moment you take a photo | The phone is holding a key from **before the last restart**. Nothing on the page reads the key until a write, so a stale one is invisible until then — it looks like a broken camera, not an auth failure | `scripts\show-phone-link.ps1` — it verifies the key against the running server and prints a fresh link. Exit 2 = the server rejects it |
| Everyone reads as `unknown` no matter what | `ACCESS_IDENTITY_METHOD` is `stub` (the default and only claimed rung) — detection-only, by design. Nothing is broken | This is expected. The loop, matrix and audit trail all run the same way; a human decides from the photo either way |
| Access card says *"presence unobservable"* | The sensor feed is stale, so the sentry froze rather than guess | Same fix as the `source: mock` row above. It is **not** filing false audit entries while in this state |
| First reply of a session takes minutes, later ones are faster | `--keepalive` defaults to **300s**, so the model unloads after 5 min idle. The watchdog never calls the model, so nothing keeps it warm | `--keepalive 3600` (step 1), or send a throwaway message a minute before presenting |
| `curl /v1/models` hangs for minutes | **Not a fault.** GenieX serializes all requests; your probe is queued behind a completion. Measured 654 µs idle vs 1m42s behind one | Health-check with `Get-Process geniex` + `Get-NetTCPConnection -LocalPort 18181`, never HTTP |
| Model replies in prose and calls **no** tools at all | `tools.tool_search.enabled` is on. Qwen3-4B will not do the 3-hop `tool_search`→`tool_describe`→`tool_call` discovery dance — it answers from memory and calls nothing | Set `tool_search.enabled: "off"` so schemas are inline, then **restart the gateway** |
| A tool that exists "does not exist"; or a code change has no effect | The gateway reads `config.yaml` **at boot only**, and MCP servers run from `mcp-tools\dist\` | Restart the gateway after any config edit; `npm run build` after any TypeScript change |
| A reading arrives as `25.081483840942383` instead of `25.1` | The tool servers are running a `dist/` built before the rounding change. The raw log *should* look like that — the cut happens laptop-side, at ingestion ([contract](mcp-tools/README.md#one-decimal-place-applied-on-the-way-in)) | `npm run build` in `mcp-tools`, then restart the gateway — same row as above |
| A `level` rule fired once and never again | **Working as designed** — level rules latch (`fired: true`) until the value crosses back and re-crosses | Check `fireCount` / `lastFiredAt` in `mcp-tools\.state\rule-state.json` before debugging |
| **GenieX vanishes — no error, no dump, no log** | Observed under load on a plain 180-token request with other traffic in flight; the *server* closed the connection, then the process was gone. 17.7 GB RAM was free, so not memory pressure. **Root cause unknown**; leading suspect is an `--nctx` / `context_length` mismatch | Make those two equal, and run `scripts\geniex-supervisor.ps1` rather than trusting the process |

Full end-to-end test procedure, layer by layer: **[docs/E2E_TEST.md](docs/E2E_TEST.md)**.

## Docs
- **[Runbook — restart, recovery, health checks](docs/RUNBOOK.md)** — **the operating manual for
  a machine that is already set up** (this README covers *installing*; that one covers *fixing*).
  The 30-second all-green check, per-component restart, why an HTTP health check against GenieX
  lies while the model is thinking, the flags that silently drift, `--keepalive` and the slow
  first reply, what actually drives prefill cost (measured — the sensor log does **not**), and a
  symptom→cause table
- **[The environmental watchdog](docs/WATCHDOG.md)** — the proactive path, end to end: which
  process is actually paging you and how to see it (`127.0.0.1:7789/health`), the measured
  sensor-edge-to-phone budget that made waiting for a cron tick ~86% of the worst case, the three
  structural reasons Hermes cron cannot tick faster than ~2 min, why 15s and not faster, the false
  *"recovered to OK"* of 2026-08-05 and the two defences against it, and the two staleness
  thresholds that look like a bug and are not
- **Phone compute plan (2026-08-05, superseded)** — planned an on-phone Qwen3 NPU benchmark over
  `adb` (no app) and a face-embedding identity rung on a Hexagon NPU. Both halves have since
  landed, each in a different shape than planned: the on-phone benchmark was **measured
  2026-08-06** (prefill 1,918 ± 16.9 tok/s —
  [RESULTS.md § Phone benchmark](llm-serving-bench/RESULTS.md#phone-benchmark-snapdragon-8-elite--2026-08-06))
  and then wired in as the live **phone-NPU failover** (dead GenieX → the phone answers in
  ~12 s, labeled degraded — [hermes-hooks/README.md](hermes-hooks/README.md)); the identity
  rung shipped instead as `face-cpu` — CPU inference on the laptop, not the phone NPU this
  plan described — built and verified live 2026-08-06, see
  [phone/README.md](phone/README.md#the-identity-ladder). Its challenge-notification item
  landed separately, in basic form: text to Telegram, no photo. The built-vs-planned line
  lives in [Today vs. planned](#today-vs-planned)
- **[The access terminal — the phone](phone/README.md)** — what the phone actually does: the
  authorisation surface, why the *notification* may be cloud but the *decision* may not, the
  four-rung identity ladder and which rungs work today, why capture uses `<input capture>`
  rather than `getUserMedia`, and exactly what is and is not stored (embeddings, never images)
- **[The live operations wall](docs/DASHBOARD.md)** — the demo-table display: what each panel reads
  and whether it is real or simulated, the rules that stop the phone panel from claiming a delivery
  that has not happened, the `/api/telegram` seam for showing genuine phone traffic, why the
  trend line can legitimately disagree with the number above it, and **§Access** — the decision
  matrix, exactly how `expected` withholds a page (held, not cancelled), and what happens when the
  sensor feed goes stale
- **[Glossary — who does what](docs/GLOSSARY.md)** — new to GenieX / QAIRT / QUAD / MCP? **Start
  here.** Every term with its one job, the five-layer stack, build-time vs demo-time, a request
  traced end to end, and the pairs that get confused for each other
- **[Architecture — end-to-end flow](docs/ARCHITECTURE.md)** — diagrams: the runtime demo path
  (sensors → agent → NPU → phone), both request flows (reactive + proactive), where QUAD sits and
  why it's a separate graph, and the one-model-two-artifacts table
- **[End-to-end test procedure](docs/E2E_TEST.md)** — board → phone, layer by layer, with a
  "Test / Expect / If it fails" per layer, the traps that produce a false pass, and a 60-second
  pre-stage smoke check
- [Requirements](docs/REQUIREMENTS.md) — the original pitch (see the note at the top — architecture has since changed)
- [Feasibility analysis](docs/FEASIBILITY.md) — reality check against the pitch's technical claims
- [Hardware utilization plan](docs/HARDWARE_UTILIZATION.md) — **the finalized architecture**: where
  the LLM runs, which model, and how the Snapdragon X Elite laptop, Samsung Galaxy S25 Ultra, Arduino
  UNO Q, and the QUAD SDK are each actually used
- [Workload placement — NPU/GPU/CPU (2026-08-05)](docs/WORKLOAD_PLACEMENT.md) — audits current
  placement against "demanding AI/LLM → NPU, lighter AI/LLM → GPU, everything else → CPU": why
  QUAD can't be the one to profile it, why GPU is currently disqualified rather than merely
  deprioritized, and the one built-but-inert candidate (face identification) for the GPU tier
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
- [On-device activity inference (2026-08-06)](docs/ONDEVICE_ACTIVITY.md) — a small local LLM
  (SmolLM2-135M-Instruct) now runs **on the UNO Q itself**, correlating recent sensor history into
  `activity-*` log lines (e.g. `activity-possible_fire_risk`, `activity-person_entered_room`).
  Covers the newly-found Adreno 702 GPU on the board, why CPU beat it on measurement (Vulkan crashed
  under load), why blind LLM classification needed a deterministic fallback to be reliable at this
  model size, and the full test/benchmark methodology
- [Code review + sensor plan (2026-08-03)](docs/REVIEW_AND_SENSOR_PLAN_2026-08-03.md) — findings
  CR-1..CR-8 and sensor upgrades S-1..S-6 with status markers (CR-1/2/3/5 + S-1 done, live-verified)

## Layout
- `mcp-tools/` — MCP servers (TypeScript) wiring network/storage/compute (realistic mocks) and environmental/physical (**real**, via UNO Q sensors) datacenter health data into the agent, plus the edge-triggered alert logic behind the proactive watchdog loop (`src/alert-skill/watch-loop.ts`, see [docs/WATCHDOG.md](docs/WATCHDOG.md)), plus the local wall display (`src/dashboard/` + the dependency-free pages in `public/`, see [docs/DASHBOARD.md](docs/DASHBOARD.md)), plus the physical-access sentry (`src/access/` — decision matrix, identity ladder, roster of embeddings, append-only audit trail) and the bridge that lets a responder on site withhold a page (`src/alert-skill/suppress.ts`)
- `uno-q/` — Arduino UNO Q app (`hermes-sensor-logger`: periodic climate `sensor_tick`, both-edge button events, and ToF presence crossings over three Bridge channels, plus the on-board SmolLM2-135M activity loop writing `activity-*` inferences to the same log, plus the LED-matrix boot/connection display), pushed to the laptop over WiFi + Tailscale, and deployment/bring-up docs
- `bench/` — NPU profiling harness (qnn-net-run against the W4A16 bundle); results in [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
- `hermes-hooks/` — gateway hooks this project adds to Hermes (source of truth; the installed copy
  under `%LOCALAPPDATA%\hermes\hooks\` is not version-controlled and `hermes update` rewrites it).
  Today: `ack`, the two-second message receipt that replaced the 60–300 s silence on the phone —
  written by the local model, carrying a wait estimate learned from the session's own turns.
  Install with `scripts\install-hermes-hooks.ps1`; design and limits in
  [hermes-hooks/README.md](hermes-hooks/README.md)
- `hermes.env.example` — template for Hermes's own `.env` (copy to `%LOCALAPPDATA%\hermes\.env`); the
  only four settings that matter plus the ack hook's optional knobs, everything else in Hermes's
  stock file can stay untouched
- `phone/` — Samsung Galaxy S25 Ultra (Snapdragon 8 Elite). **No app to build**: the phone runs
  Telegram plus the access terminal served from the laptop at `/phone.html` — the authorisation
  surface, the rack camera, and roster enrolment. Its NPU is measured **and on call**: the
  Qwen3-4B benchmark ran 2026-08-06 (prefill 1,918 ± 16.9 tok/s over `adb`) and now backs the
  live phone-NPU failover — dead GenieX → the phone answers, labeled degraded
  ([phone/README.md](phone/README.md), [hermes-hooks/README.md](hermes-hooks/README.md))
