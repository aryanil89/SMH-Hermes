# Architecture — end-to-end flow

Diagrams for how the pieces are actually wired: the runtime demo path, the two request flows,
and where QUAD sits relative to all of it. Terms are defined in [GLOSSARY.md](GLOSSARY.md);
status detail lives in [../PROGRESS.md](../PROGRESS.md) — the `❌`/`⚠️` markers here just point at
items tracked there and in [REVIEW_AND_SENSOR_PLAN_2026-08-03.md](REVIEW_AND_SENSOR_PLAN_2026-08-03.md).

**The one structural fact everything else follows from:** the build-time graph (§3) and the runtime
graph (§1) are **disjoint** — they share the laptop and nothing else. No QUAD output is in the demo
path. That is why QUAD's hosted cloud server doesn't compromise the on-device pitch, and also why
the never-run profiling step costs scoring points without costing any function.

---

## §1 Runtime — what runs during the demo

```mermaid
flowchart TD
    subgraph board["Arduino UNO Q  (sensing tier)"]
        TH["Modulino Thermo — temp + humidity"]
        DI["Modulino Distance — mm, presence gate at 1000mm"]
        BU["Modulino Buttons — A / B / C"]
        MCU["STM32 sketch.ino"]
        PY["main.py (App Lab container)"]
        LOG["sensor_log.jsonl"]
        PUSH["push_sensor_log.sh — scp every 10s"]
        TH -->|"I2C on Wire1 (Qwiic)"| MCU
        DI -->|"I2C on Wire1 (Qwiic)"| MCU
        BU -->|"I2C on Wire1 (Qwiic)"| MCU
        MCU -->|"Bridge.notify — climate sensor_tick ~10s + button transitions (both edges) + presence crossings"| PY
        PY --> LOG
        LOG --> PUSH
    end

    subgraph laptop["Snapdragon X Elite laptop  (reasoning tier)"]
        FILE["arduino_uno_q-sensor_log.json"]
        ENV["environmental server — REAL"]
        NET["network server — mock"]
        STO["storage server — mock"]
        COM["compute server — mock"]
        HA["Hermes Agent — MCP client, skills, memory, cron"]
        WD["watchdog loop — 15s tick, health 127.0.0.1:7789"]
        GX["GenieX serve — 127.0.0.1:18181  ✅ running"]
        MOD["Qwen3-4B-Instruct-2507 — GGUF Q4_0, 64K ctx"]
        NPU["Hexagon NPU v73 — CPU stays at 12-17%"]
        STATE["mcp-tools/.state/environmental-watch.json"]
        WALL["wall display — 127.0.0.1:7788, SSE every 2s"]
        BROW["local browser (demo table)"]
        FILE --> ENV
        ENV -->|stdio| HA
        NET -->|stdio| HA
        STO -->|stdio| HA
        COM -->|stdio| HA
        HA -->|"POST /v1/chat/completions"| GX
        GX -->|"llama.cpp Hexagon backend"| MOD
        MOD --> NPU
        FILE --> WD
        WD -->|"every 15s, writes atomically"| STATE
        FILE -.->|"reads the log directly"| WALL
        WD -.->|"health probe"| WALL
        STATE -.->|"mirrors real deliveries"| WALL
        WALL --> BROW
    end

    subgraph phone["Galaxy S25 Ultra  (mobility tier)"]
        TG["Telegram app"]
    end

    PUSH -->|"scp over Tailscale — LAN/VPN, no cloud"| FILE
    HA <-->|"Telegram Bot API  ☁️ ONLY cloud hop  ✅ wired, outbound verified"| TG
```

> Telegram round-trip caveats (found during wiring — details in [../PROGRESS.md](../PROGRESS.md)
> NEXT 4): Hermes must run **non-streaming** against GenieX (`HERMES_FORCE_NONSTREAM=1`; a local
> patch that `hermes update` would revert), and a phone reply takes **2–4 minutes** — scope demo
> questions to one tool call. Non-streaming means the phone sees nothing for those minutes, so
> the gateway sends a model-written **receipt** within ~2 s first (the `ack` hook,
> [../hermes-hooks/README.md](../hermes-hooks/README.md)); §2 shows where it sits in the turn.

Everything inside the laptop box survives a WiFi cut — that is the scoped offline demo beat.
Telegram (and only Telegram) needs the internet.

> **Two later additions this diagram predates** (the validated figure is left as-is on purpose;
> each addition has its own doc). **(1) Phone-NPU failover** — the S25 Ultra is no longer only
> the Telegram surface: when GenieX dies (TCP connect refused, never an HTTP probe), the
> inbound question is answered by the phone's 8 Elite NPU over `adb` (one-shot
> `genie-t2t-run`, no tools, labeled degraded; **12.0 s** message→delivered, n=1, of which the
> phone leg is 7.1 ± 0.7 s over n=5 —
> [../hermes-hooks/README.md](../hermes-hooks/README.md)). **(2) On-board activity inference**
> — the UNO Q itself runs SmolLM2-135M on its CPU, correlating its recent sensor history into
> `activity-*` lines that ride the same push pipeline; the watchdog folds fresh ones into the
> Telegram alert text and the wall streams them ([ONDEVICE_ACTIVITY.md](ONDEVICE_ACTIVITY.md)).
> Net effect: **three devices, three inference tiers** — X Elite Hexagon (the agent), 8 Elite
> Hexagon (failover), UNO Q Cortex-A53 (edge pre-correlation) — each sized to the job it does.

The **wall display** is drawn with dashed edges deliberately: it is a read-only observer, not part
of the reasoning path. It re-derives its numbers by calling the same functions the MCP tools call
(`getEnvironmentalReading`, `assessIncident`, the three family generators) rather than intercepting
anything, so removing it changes nothing about what the agent does or answers. It reads the sensor
log and the watchdog's state file; it writes neither. Detail in [DASHBOARD.md](DASHBOARD.md).

## §2 The two request paths

### Reactive — a human asks

```mermaid
sequenceDiagram
    participant P as Phone (Telegram)
    participant H as Hermes Agent
    participant G as GenieX :18181
    participant E as environmental server
    participant F as sensor log file

    P->>H: "what's the temperature in rack B1?"  (cloud hop)
    H->>G: ack hook: 200-token receipt prompt (before the agent's first call)
    G-->>H: "Pulling the temperature data from rack B1 now - about a minute."
    H-->>P: receipt, italic (~2s)
    Note over H,G: Ordering is the design: GenieX serializes, so a receipt<br/>generated after the turn starts would queue behind it
    H->>G: POST /v1/chat/completions + tool definitions
    G-->>H: finish_reason tool_calls (model asks for the tool)
    H->>E: get_environmental_status (stdio)
    E->>F: read newest line (1h staleness guard)
    F-->>E: temp / humidity / leak + ageSeconds
    E-->>H: reading (source real or mock + fallbackReason)
    H->>G: tool result back into context
    G-->>H: natural-language answer
    H-->>P: reply via Telegram (cloud hop)
    Note over H,F: Everything between Hermes and the file is local — works with WiFi off
```

### Proactive — nobody asked

```mermaid
sequenceDiagram
    participant C as watch-loop.js every 15s
    participant S as runWatchTick (tick.ts)
    participant K as reading + persisted state
    participant D as decideAlert
    participant A as suppress.ts + access.json
    participant P as Phone (Telegram)

    C->>S: tick (skipped, never queued, if one is still running)
    S->>K: read sensor log + .state/environmental-watch.json
    K->>D: current status + persisted state + readingTrusted
    alt reading is mock (source != "real")
        D-->>K: untrusted-reading — state carried forward verbatim
        Note over D: A fallback reading can neither raise nor clear an alarm.<br/>This is the fix for the false "recovered to OK" of 2026-08-05.
    else threshold crossed or recovered
        D-->>K: ALERT status + message
        K->>A: is a known responder on site?
        alt verdict = expected, state fresh, no escalation
            A-->>K: HOLD
            K-->>S: nothing to send + record heldPage
            Note over K,A: lastStatus is NOT advanced — the crossing stays<br/>un-notified, so it fires the moment they leave
        else nobody there / escalated / access state stale
            A-->>K: PAGE
            K-->>S: "Environmental status is now CRITICAL ..."
            S->>P: Telegram Bot API, direct  ☁️
        end
    else nothing changed
        D-->>K: no alert
        K-->>S: nothing to send
        Note over S: stays silent — the normal outcome on most ticks
    end
    Note over C,D: Edge-triggered with cooldown + recovery — not "alert every tick".<br/>Zero LLM tokens: the model is never in this path.
    Note over A: Fails OPEN. Suppression needs the dashboard alive to write<br/>access.json — a stale file pages rather than staying quiet.
```

**Cadence.** 15s, from `watch-loop.ts`, which replaced a `hermes cron` job that could not run
faster than ~2 minutes no matter what schedule it was given. Measured sensor-edge-to-phone
latency fell from a 102s worst case to roughly 15–30s. The full measurement, the three
independent reasons cron floors out, and the cutover procedure are in
**[WATCHDOG.md](WATCHDOG.md)**. The one-shot `check-environmental.js` still exists and shares
the same tick code; the legacy cron job can still drive it.

## §3 Build-time — QUAD, a separate graph entirely

```mermaid
flowchart LR
    subgraph dev["Developer machine"]
        CC["Claude Code — MCP client"]
    end

    subgraph quad["Hosted QUAD MCP server — quad.infra.foundries.io"]
        HD["hardware_detect  ✅ used — X1E80100 / Hexagon v73 validated"]
        AS["aihub_select  ➖ superseded — geniex pulled the bundle instead"]
        CM["convert_model  ➖ not needed — prebuilt bundle exists"]
        PW["profile_workload  ❌ never called — the 40-point gap"]
        OW["orchestrate_workload  ❌ never called"]
        GC["generate_code  ➖ not needed"]
        PD["profile_device  ⬜ available — the route for UNO Q telemetry"]
    end

    BUNDLE["qualcomm/Qwen3-4B-Instruct-2507 W4A16 — 3.0 GiB, cached, NOT the served model"]

    CC -->|"sse-http + bearer token"| quad
    PW -.->|would read| BUNDLE
    OW -.->|would read| BUNDLE
```

**Nothing in this diagram appears in §1.** QUAD's job ends before the demo starts — "model
converted, verified on the NPU, profiled" — and in this project even the convert step was
unnecessary because a prebuilt AI Hub bundle existed.

Live blocker: the `mcp__quad__*` tools are registered (`claude mcp list` → ✔ Connected) but **not
loaded in the current Claude Code session** — a session restart is the precondition for any
profiling run ([../PROGRESS.md](../PROGRESS.md) NEXT item 7).

## §4 One model, two artifacts

The same Qwen3-4B-Instruct-2507 exists on this laptop as two artifacts with incompatible
capabilities — conflating them is the most common confusion in this project:

| | **W4A16 bundle** (qairt path) | **GGUF Q4_0** (llama.cpp path) |
|---|---|---|
| Context | fixed 4K | **64K** (`--nctx 65536`) |
| Tool calls | ❌ not parsed | ✅ structured `tool_calls` |
| NPU | ✅ (qairt) | ✅ (Q4_0 only — Q4_K_M silently falls back to CPU) |
| Role | **profiling / benchmark target** | **serves Hermes** |
| Status | **profiled per-op on Hexagon v73** — [BENCHMARKS.md](BENCHMARKS.md) | live on `:18181` |

Consequence for the writeup and the demo: **profile the bundle, serve the GGUF — and say so
explicitly**, so the benchmark doesn't read as a bait-and-switch. Evidence:
[NPU_SPIKE_RESULTS.md](NPU_SPIKE_RESULTS.md).

## §5 Gap summary — every marker above, tracked elsewhere

| Marker | What | Tracked as |
|---|---|---|
| ✅ periodic sensor sampling | **CR-1 closed** — the sketch emits a `sensor_tick` ~every 10 s *in addition to* event channels, so the tool no longer degrades to mock between presses. Since 2026-08-05 the tick carries **temperature + humidity only** | [REVIEW_AND_SENSOR_PLAN_2026-08-03.md](REVIEW_AND_SENSOR_PLAN_2026-08-03.md) |
| ⚠️ `distance_mm` surfaced | **CR-2 closed**, then narrowed. Distance now reaches the laptop **only** on presence (`object_entered`/`object_left`) and button lines, gated to readings under 1000mm. Because the reader takes the newest line — almost always a tick, which has no distance — **level-based leak detection is no longer reachable**; button C is the live leak path. Restoring it means putting `distance_mm` back on the tick | [../uno-q/hermes-sensor-logger/README.md](../uno-q/hermes-sensor-logger/README.md) |
| ⚠️ Telegram round-trip constraints | wired ✅, but requires the non-streaming local patch (`HERMES_FORCE_NONSTREAM=1`, reverted by `hermes update`) and replies take 2–4 min | [../PROGRESS.md](../PROGRESS.md) NEXT 4 |
| ⚠️ NPU claim now measured, but not by `profile_workload` | The bundle **is** profiled per-op on Hexagon (prefill/decode latency + HTP cycle counts). `profile_workload` itself was unusable — the QUAD server is a remote x86 VM with no Hexagon and no access to local disk — so the numbers come from `qnn-net-run` + `qnn-profile-viewer`, driven by `profile_device_plan` | [BENCHMARKS.md](BENCHMARKS.md), [../PROGRESS.md](../PROGRESS.md) NEXT 7 |
| ✅ proactive alerting, now off cron entirely | Ran as a `--no-agent` Python script under `hermes cron`; the original `.sh` wrapper failed *every scheduled tick* (WSL had no `/bin/bash`, fixed 2026-08-04), and then measurement showed cron could not tick faster than ~2 min regardless of schedule. Since 2026-08-05 the path is `watch-loop.ts`, a 15s persistent loop delivering to Telegram directly. Verify via a real tick, never a one-off run | [WATCHDOG.md](WATCHDOG.md), [E2E_TEST.md](E2E_TEST.md) §7 |

This section is a pointer, not a tracker — status truth lives in PROGRESS.md.
