# Hermes: On-Device AI Operations Engineer
Project Hermes — Snapdragon Multiverse Hackathon 2026

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

Built on [Hermes Agent](https://github.com/nousresearch/hermes-agent) + Qwen3-4B-Instruct-2507,
NPU-accelerated via Qualcomm GenieX, with infrastructure exposed through MCP tool servers.

> **Disclosure:** network, storage and compute telemetry are **simulated** with realistic data
> patterns; the environmental path is **live** from an Arduino UNO Q. The MCP adapters are the seam —
> the same tools can be pointed at real DCIM/BMS/SNMP without touching the reasoning layer. We
> measured the simulator's own false-positive rate and recalibrated it — see
> [docs/REVIEW_3_2026-08-04.md](docs/REVIEW_3_2026-08-04.md) §2.
>
> **On identity:** there is no automated identity check today — no badge or QR reading, no face
> recognition. The one physical-security signal is the Modulino Distance sensor detecting presence
> (under 1000mm); that opens a challenge, a photo is captured, and a human approves or denies on
> the phone. Presence, door state, the decision matrix and the approval loop are all real and live.
> The codebase has a pluggable identity-adapter interface (`qr-badge`, `face-npu`, `face-cpu`)
> behind this, but none of those rungs are demonstrated or claimed — see
> [phone/README.md](phone/README.md) § the identity ladder.

## Status
**[PROGRESS.md](PROGRESS.md)** — the living done/next map. Read this first.
**[docs/POSITIONING.md](docs/POSITIONING.md)** — the approved wording: pitch, offline claim, judge answers.

## Today vs. planned

Everything in the left column is built and verified on this rig; everything in the right
column is **designed but NOT built** — the full design, with feasibility research and
verified download paths, is [docs/PHONE_PLAN_2026-08-05.md](docs/PHONE_PLAN_2026-08-05.md).
The two columns are kept side by side on purpose: unbacked claims score zero, so the line
between them is part of the submission, not a footnote.

| Area | Today (built, verified) | Planned (not built) |
|---|---|---|
| LLM inference | Qwen3-4B-Instruct-2507 Q4_0 on the **laptop's** X Elite NPU via GenieX — measured, serving the agent | Same model benchmarked on the **phone's** 8 Elite NPU via a pre-compiled bundle over `adb` — same GGUF, two Hexagon NPUs, one table |
| Physical access | Presence (ToF distance sensor, <1000mm) → challenge → photo captured → human approve/deny on the phone's local page → append-only audit trail. No automated identity match — a human makes every call | Automated identity resolution — badge/QR reading, face recognition (`ACCESS_VISION_SCRIPT` seam exists but is unwired) — **not** claimed |
| Phone's role | Approval terminal (`phone.html`) + Telegram client + **challenge notification pushed to Telegram** (text only, deliberately no photo; fire-and-forget, silent no-op when unconfigured) — no on-phone inference | On-phone LLM benchmark, "failover brain" demo beat |
| Alert suppression | **Wired and verified end to end**: an enrolled responder on site withholds the page; walking away releases it *("held while the on-call was on site; sending now")*; escalation or a stale access state pages regardless | — |
| Energy | No energy numbers exist yet | Measured joules-per-token on both NPUs, with error bars and methodology |

## Run it yourself — the whole flow, in start order

The stack is seven pieces. Start them in this order; each step says what it is, the exact command,
and how to know it worked. The flow being started:

```
[1] GenieX model server (NPU)  ←  [3] Hermes Agent  →  [4] Telegram gateway → phone
                                        ↑ stdio (automatic)
                                  [MCP tool servers: network/storage/compute = mock,
                                   environmental = real, assessment = the one-call verdict]
                                        ↑ log file
                                  [2] Arduino UNO Q sensors → WiFi + Tailscale VPN
                                  [5] cron watchdog → proactive Telegram alerts
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
| **Node 18+** | For the MCP tool servers (verified on v24.18) |
| **`adb`** | Only for flashing/configuring the board (sketch + app deploy, initial WiFi/Tailscale setup, clock sync) — it carries no sensor traffic. Ships inside the scrcpy package: `winget install Genymobile.scrcpy` — this is not obvious |
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
cd mcp-tools; npm install; npm run build; npm test      # expect 107/107 passing
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
  assessment:                             # get_incident_assessment - one call, one verdict
    command: node
    args: [ "<REPO>\\mcp-tools\\dist\\servers\\assessment-server.js" ]
    env:
      UNOQ_SENSOR_LOG: "<REPO>\\arduino_uno_q-sensor_log.json"
      UNOQ_LOG_MAX_AGE_S: "180"           # it reads the sensor path too - keep these in sync
```

⚠️ **Register `assessment` — it is easy to miss and it is the one that matters on stage.** Each
agent turn costs a full prompt re-prefill on the NPU (2–4 min), so a four-status-call answer is a
ten-minute answer. `get_incident_assessment` does all four families plus the risk and confidence
arithmetic in one call. Confirm it is live with `hermes -z "assess the current incident"`. If the
laptop's existing `config.yaml` only lists four servers, this is the missing one.

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
| `%LOCALAPPDATA%\hermes\config.yaml` | 5 × `mcp_servers` args + 2 × `UNOQ_SENSOR_LOG` |
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

The board app auto-starts on boot and writes one `sensor_tick` line (temperature + humidity) every
10s to its local log, plus one line per button transition — both press *and* release — and one per
ToF presence crossing. Getting that file **to the laptop** is WiFi + Tailscale, and nothing else:
nothing to start on the laptop — the board's `hermes-sensor-logger-push.service` scp-pushes every
10s over the tailnet, *if* the board has WiFi and its Tailscale is authed (`tailscale status` on
the board; re-auth after long offline periods).

**USB-C is configuration only** — flashing the board app, initial WiFi/Tailscale provisioning, and
one-off admin commands like the clock sync below. It never carries sensor data to the server.

⚠️ **After any board power-up without network**: the UNO Q has no RTC battery — it boots in 1970,
all timestamps go wrong, and the staleness guard will (correctly) reject its data. Fix from the
laptop over USB:
```powershell
$utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss")
adb shell "docker run --rm --user 0 --cap-add SYS_TIME --entrypoint date ghcr.io/arduino/app-bricks/python-apps-base:0.5.0 -u -s '$utc'"
```

**Worked when:** `arduino_uno_q-sensor_log.json` at the repo root gets a fresh `sensor_tick` line
every ~10–20s. If you edited the board app, redeploy over USB:
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

1. Press and **hold** button C on the UNO Q (press logs `leak_detected`; releasing logs
   `leak_cleared`, which cancels the alert rather than re-raising it). The water-level path is not
   currently reachable — see the warning in [uno-q/README.md](uno-q/README.md).
2. Within one 5-min tick (or immediately via `hermes cron run <job-id>`): **ALERT on the phone.**
3. ~5–10 min later: a one-time "recovered to OK" push — that's edge-triggered recovery working,
   not a bug.

⚠️ **The watchdog can now stay silent on purpose.** If an enrolled person is standing at the rack
while an incident is live (step 7), the page is **withheld** — you are looking at the thing it
would have told you about. It is a deferral, not a cancellation: walk away and the alert arrives
marked *"held while the on-call was on site; sending now."* Escalation while you stand there pages
anyway, and if the wall isn't running the state goes stale and it pages regardless. So "no alert"
has two causes now — nothing wrong, or someone is on site. The wall says which.

### 6. The wall display — one page showing all of the above

A local web page for the demo table: the UNO Q and its door / lighting / leak / temperature /
humidity state on the left, the server ingesting that feed alongside the network, storage and
compute telemetry — and the inference it draws from them — in the middle, and the phone's Telegram
thread on the right.

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
agent falls back to mock while the wall still shows a live feed. Full reference, including how to
put real phone traffic on the Telegram panel: **[docs/DASHBOARD.md](docs/DASHBOARD.md)**.

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

What it does: someone approaches the rack, the ToF presence sensor (< 1000mm) opens a
**challenge**, you photograph them with one tap, and an 8-row decision matrix produces a verdict
in context — including **tailgating** (more faces than authorised door entries) and
**anti-passback** (at the rack with no door edge). There is no automated identity check: the
default and only claimed rung is detection-only, so every face reads as unknown and a human
approves or denies **on this page**, not over Telegram, based on the photo. (The codebase also has `qr-badge`/`face-npu`/`face-cpu` identity rungs behind a pluggable
interface — none are part of what's demoed or claimed. `qr-badge` has no real badge behind it,
just a typed name treated as a credential; `face-npu`/`face-cpu` need an external script that
doesn't exist in this repo — see [phone/README.md](phone/README.md#the-identity-ladder).)

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

**Privacy — the point of doing this on-device:** captures are resolved to a numeric embedding and
the image is discarded. `mcp-tools/.state/roster.json` holds floats only; you cannot reconstruct a
face from it, and it is safe to open on stage. `.gitignore` blocked `*.jpg`, `roster.json` and
`.state/` **before the first capture existed**. Full reference: **[phone/README.md](phone/README.md)**.

### Quick health check, all seven

```powershell
curl.exe -s http://127.0.0.1:18181/v1/models                      # [1] model server up
Get-Item arduino_uno_q-sensor_log.json | % LastWriteTime          # [2] fresh = sensors flowing
node mcp-tools\dist\alert-skill\check-environmental.js --json     # [tools] source: real
hermes -z "what's the temperature in rack B1?"                    # [3] agent + tools + NPU
hermes gateway status                                             # [4] telegram connected
hermes cron list                                                  # [5] Environmental watch active
curl.exe -s http://127.0.0.1:7788/api/health                      # [6] wall display up, feed state
curl.exe -s http://127.0.0.1:7788/api/access/state                # [7] access verdict + roster
```

## Troubleshooting — symptom → cause

Every row here cost us real time; none are hypothetical.

| Symptom | Cause | Fix |
|---|---|---|
| Telegram **questions** fail — *"model provider failed after retries"*; log shows `APIConnectionError … 127.0.0.1:18181` | **GenieX isn't running.** Nothing auto-starts it after a reboot | Redo step 1. Note the **cron alerts keep arriving while this is broken** — they never call the model, so "alerts are fine" is *not* evidence the agent is fine |
| Replies never finalize; Hermes retries forever | The non-streaming patch was reverted — usually by `hermes update` | Re-apply the patch and keep `HERMES_FORCE_NONSTREAM=1` |
| `"source": "mock"`, reason *"sensor log is stale"* | Board clock is wrong. The UNO Q has **no RTC battery**, so every power-up without network resumes hours behind and its timestamps look ancient | Set the clock over USB — step 2 ⚠️. **Do this after every board boot** |
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
| Everyone reads as `unknown` no matter what | `ACCESS_IDENTITY_METHOD` is `stub` (the default and only claimed rung) — detection-only, by design. Nothing is broken | This is expected. The loop, matrix and audit trail all run the same way; a human decides from the photo either way |
| Access card says *"presence unobservable"* | The sensor feed is stale, so the sentry froze rather than guess | Same fix as the `source: mock` row above. It is **not** filing false audit entries while in this state |

Full end-to-end test procedure, layer by layer: **[docs/E2E_TEST.md](docs/E2E_TEST.md)**.

## Docs
- **[Phone compute plan (2026-08-05)](docs/PHONE_PLAN_2026-08-05.md)** — **planned, not
  built**: the designed next step for the Galaxy S25 Ultra — on-phone Qwen3 NPU benchmark
  over `adb` (no app), the face-embedding identity rung, and measured joules-per-token on
  both NPUs — with the feasibility research and verified download paths behind each piece.
  (Its challenge-notification item has since **landed** in its basic form: text to Telegram,
  no photo.) The built-vs-designed line lives in [Today vs. planned](#today-vs-planned)
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
- [Response to the GPT review](docs/FEEDBACK_RESPONSE_2026-08-04.md) — accept/reject verdict on all
  30 proposed improvements, the four that don't survive scrutiny (latency budget, uncoupled
  simulators, additive risk double-counting, uncalibrated confidence), and the remaining build list
- [Requirements](docs/REQUIREMENTS.md) — the original pitch (see the note at the top — architecture has since changed)
- [Feasibility analysis](docs/FEASIBILITY.md) — reality check against the pitch's technical claims
- [Hardware utilization plan](docs/HARDWARE_UTILIZATION.md) — **the finalized architecture**: where
  the LLM runs, which model, and how the Snapdragon X Elite laptop, Samsung Galaxy S25 Ultra, Arduino
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
- `mcp-tools/` — MCP servers (TypeScript) wiring network/storage/compute (realistic mocks) and environmental/physical (**real**, via UNO Q sensors) datacenter health data into the agent, plus the edge-triggered alert logic behind the proactive cron watchdog, plus the local wall display (`src/dashboard/` + the dependency-free pages in `public/`, see [docs/DASHBOARD.md](docs/DASHBOARD.md)), plus the physical-access sentry (`src/access/` — decision matrix, identity ladder, roster of embeddings, append-only audit trail) and the bridge that lets a responder on site withhold a page (`src/alert-skill/suppress.ts`)
- `uno-q/` — Arduino UNO Q app (`hermes-sensor-logger`: periodic climate `sensor_tick`, both-edge button events, and ToF presence crossings over three Bridge channels, plus the LED-matrix boot/connection display), pushed to the laptop over WiFi + Tailscale, and deployment/bring-up docs
- `bench/` — NPU profiling harness (qnn-net-run against the W4A16 bundle); results in [docs/BENCHMARKS.md](docs/BENCHMARKS.md)
- `hermes.env.example` — template for Hermes's own `.env` (copy to `%LOCALAPPDATA%\hermes\.env`); the
  only five settings that matter, everything else in Hermes's stock file can stay untouched
- `phone/` — Samsung Galaxy S25 Ultra (Snapdragon 8 Elite). **No app to build**: the phone runs
  Telegram plus the access terminal served from the laptop at `/phone.html` — the authorisation
  surface, the rack camera, and roster enrolment. Its NPU is **not** in use yet; the on-phone
  Qwen3-4B benchmark remains the stretch goal ([docs/PHONE_PLAN_2026-08-05.md](docs/PHONE_PLAN_2026-08-05.md))
