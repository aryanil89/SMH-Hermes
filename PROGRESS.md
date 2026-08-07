# SMH-Hermes — Progress & Plan (living doc)

Last updated: **2026-08-06 — on-device activity inference shipped on the UNO Q (SmolLM2-135M, CPU) — see item 22**.
One file for where the
project stands, what's proven, and what's next. Detail lives in the linked docs; this is
the map. Picking this up fresh? Read the done table, then **"Leftovers — next session
starts here"** below it.

## Current state — what is DONE and verified

| # | Item | Evidence |
|---|---|---|
| 1 | **Docs audit** — every technical claim in REQUIREMENTS/FEASIBILITY/HARDWARE_UTILIZATION checked against primary sources; risks prioritized P0–P4 | [docs/AUDIT_2026-08-03.md](docs/AUDIT_2026-08-03.md) |
| 2 | **P0 + P1 resolved empirically** — `geniex serve --nctx 65536 --compute npu` + Qwen3-4B-Instruct-2507 **Q4_0** GGUF = OpenAI endpoint with structured tool calls, 64K context, NPU-offloaded compute (CPU 12–17% vs 56–74% on fallback). qairt W4A16 bundle confirmed benchmark-only (4K ctx, no tool-call parsing) | [docs/NPU_SPIKE_RESULTS.md](docs/NPU_SPIKE_RESULTS.md) |
| 3 | **GenieX installed** on the X Elite — CLI v0.3.18 (`%LOCALAPPDATA%\GenieX CLI\geniex.exe`, on PATH), Python bindings in `..\.venv-geniex` (native ARM64 py3.12), QAIRT 2.45 | spike doc §Environment |
| 4 | **Models cached** — `qualcomm/Qwen3-4B-Instruct-2507:W4A16` (NPU bundle, 3.0 GiB), `unsloth/Qwen3-4B-Instruct-2507-GGUF` in Q4_K_M and **Q4_0** | `geniex ls` |
| 5 | **QUAD MCP server registered** with Claude Code (`https://quad.infra.foundries.io/mcp`, ✔ Connected). `mcp__quad__*` tools appear after a session restart | `claude mcp list` |
| 6 | **Hardware validated** via `quad-detect` — X Elite X1E80100, 12× Oryon, Adreno X1-85, Hexagon v73 (45 TOPS), 31.6 GB RAM, QAIRT SDK 2.32.6, runtimes cpu+npu | detect output |
| 7 | **MCP tool servers built + tested** — network/storage/compute (realistic mocks: topology, degraded-link probabilities, thresholds) and environmental (UNO Q pull client + mock fallback); edge-triggered alert logic (`decide-alert`) with cooldown/recovery; `environmental-watch` cron skill written | `mcp-tools/` (vitest suites) |
| 8 | **UNO Q provisioned** — WiFi, Tailscale, SSH-to-laptop, button-triggered sensor logging pushed to the laptop every 10s | [docs/UNOQ_SETUP.md](docs/UNOQ_SETUP.md) |
| 9 | **Newcomer glossary + doc-hygiene pass** — "who does what" orientation doc (cast list, 5-layer stack, build-time vs demo-time, request walkthrough, confused-pairs); bogus UNO Q specs corrected from the audit; obsolete WSL2 risk closed in FEASIBILITY + HARDWARE_UTILIZATION; competitor claim softened; mcp-tools status + env-var docs corrected; **`.gitignore` now blocks `telegram_info` and the confidential hackathon PDF** from reaching the public repo | [docs/GLOSSARY.md](docs/GLOSSARY.md) |
| 10 | **Architecture diagrams** — 4 Mermaid diagrams (runtime demo path with gap markers; reactive + proactive sequence flows; QUAD build-time graph with per-tool usage status; one-model-two-artifacts table). All 4 validated with mermaid-cli. Encodes the disjoint-graphs fact: QUAD and the runtime share only the laptop | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 11 | **Live operations wall** (2026-08-05) — a local read-only page showing the whole demo at once: the UNO Q's door/lighting/leak/temperature/humidity state, that feed arriving at the server beside the network/storage/compute telemetry, the assessment drawn from all of it, and the phone's Telegram thread. Calls the same functions the MCP tools call (one world seed per tick), so it cannot disagree with the agent. No dependencies, no build step, loopback only — it survives the WiFi cut. Verified end to end on a live log: leak → CRITICAL → queued alert → real watchdog tick → delivered bubble carrying the identical text → recovery. **15 new tests, suite 107/107** | [docs/DASHBOARD.md](docs/DASHBOARD.md) |

| 12 | **Access sentry — the phone becomes the authorization plane** (2026-08-05). POSITIONING §7 promised *"observe → explain → recommend → **human approves** → act"* and **no approval mechanism existed**; meanwhile the board's `door_*` and `object_*` channels had been reported for days and were only ever *drawn*. Now: presence opens a challenge → the phone captures → identity resolves down a 4-rung ladder → an 8-row decision matrix (incl. **tailgating** = faces vs authorised entries, and **anti-passback** = at the rack with no door edge) → a human approves on the **local** page. Telegram carries the notification; it does not carry the authorisation. Roster holds **embeddings only, never images**, git-ignored before the first capture existed. **50 new tests, suite 189/189**; verified live end to end incl. tailgating → approve → audit | [phone/README.md](phone/README.md), [docs/DASHBOARD.md](docs/DASHBOARD.md) |

| 13 | **Access sentry — claims made true** (2026-08-05), after an independent review. **The centerpiece was dead code**: `shouldSuppressPage` had zero call sites outside its own test and nothing in the paging chain imported `access/`, so "a known responder on site stops it paging you" changed a caption on the wall and pages went out regardless — refutable live by a skeptic saying *"show me it not paging."* Now wired via `alert-skill/suppress.ts` and verified end to end: on site → silent; walk away → the held page fires; escalate → pages anyway; stale state → pages anyway. Also fixed from the same review: a POST rejection could **kill the whole server** (unguarded `void` dispatch + a routine Windows file lock), a stale board **falsified the audit trail** (filed "presence ended with no decision" when the feed died), and stored **XSS** on the approval terminal. **58 access tests, suite 242/242** | [docs/DASHBOARD.md](docs/DASHBOARD.md) §Access |

| 14 | **Measurement campaign complete** (2026-08-05 PM) — every headline number is now measured, not modeled. §1 served throughput finalized: NPU **382 ± 8.3** prefill (5 nonce-prefixed reps) vs CPU **35 ± 7.2** → **~9× faster agent iterations** (41 s vs 371 s modeled), CPU visibly thermal-throttling (46→27 tok/s) while NPU held steady. Long-context curve measured **directly**: 206 tok/s @ the real 12.7K request shape (honest iteration ≈ **68 s**), 108 tok/s @32K → the worst turn Hermes can send = **293 s**, validating the 900 s stale ceiling with 3× headroom. **Found + documented: ~60K prefill crashes GenieX v0.3.18 on NPU** (`dspqueue_read 0x72`) — `compression.threshold: 0.5` (32K) is the production guard, never raise it. **§2 energy measured: NPU 471 J/query** at the 12.7K shape (inference adds just **+6.3 W** system power) vs CPU **~8.7× more J per token** (+21.3 W and ~7× slower) — HWiNFO CSV integration, arXiv 2606.11257 method | [llm-serving-bench/RESULTS.md](llm-serving-bench/RESULTS.md) |

| 15 | **Message receipts — the phone stops guessing** (2026-08-05 PM). Reported from the phone: *"it is not clear the server has received the message and is processing the request. Sometimes it responds a few minutes later, sometimes it does not."* PERF-DESIGN P3 had already verified the Telegram typing indicator works — and it does not solve this: it expires between refreshes, never reaches the notification shade, and looks identical whether the gateway is thinking, wedged, or dead. **The defect was unobservability, not latency**: nothing on the phone distinguished *received-and-working* from *dropped*. Now every inbound message gets an italic one-line receipt in ~2 s, written by the same local model, naming what was asked and carrying a wait estimate learned from that session's own measured turns. It is generated **before** the agent's first model call — GenieX serializes, so a receipt generated afterwards would queue behind the answer it announces — and it asserts no findings (prompt + regex backstop; nothing has been looked up yet). Model down or slow → it still goes out, canned, with the estimate, which turns *"did it hear me?"* into *"it heard me and could not answer."* **51 offline self-test checks, run by the installer before it will install** | [hermes-hooks/README.md](hermes-hooks/README.md), [docs/PERF-DESIGN.md](docs/PERF-DESIGN.md) §P3 follow-up |
| 16 | **One decimal place, everywhere a number is reported** (2026-08-05 PM). The board logs raw Modulino floats — `"temperature_c": 25.081483840942383` — and those 17 digits were reaching the agent, the alert text, the wall and the learned baselines verbatim. Now every measurement that leaves the system is cut to one decimal by [`common/round.ts`](mcp-tools/src/common/round.ts), applied **at ingestion rather than at each display**, so the number the agent reasons on, the number a threshold is compared against, the number in the Telegram alert and the number on the wall are one number. That ordering fixes a real disagreement, not just presentation: `file-source.ts` now rounds `distance_mm` **before** testing it against `UNOQ_LEAK_DISTANCE_MM`, so a raw 149.96 against a 150mm threshold reports `150` **and** `no leak` instead of paging a leak beside a distance that reads as exactly at the line. Covers temp/humidity/distance, the network/storage/compute mocks, and the baselines quoted back as facts about the room; face embeddings keep 3 decimals, deliberately. Verified on the live feed. **11 new tests (incl. a 60-seed sweep asserting no generated number exceeds 1dp), suite 289/289** | [mcp-tools/README.md](mcp-tools/README.md#one-decimal-place-applied-on-the-way-in) |

| 17 | **The watchdog stops waiting for a clock** (2026-08-05 PM). Measured, not assumed: two real button presses timed end to end gave **14.2 s** and **102.2 s** sensor-edge-to-phone, of which **7.5 s and 88.1 s was waiting for the next cron tick — ~86% of the worst case**. The cause is structural and unreachable by config: `parse_duration` has no seconds unit, the ticker polls a fixed 60 s grid, and `next_run_at` is computed from *completion*, so an `every 1m` job really fires every **120 s** (415 executions) and `every 5m` every **360 s** (113). Replaced by [`watch-loop.ts`](mcp-tools/src/alert-skill/watch-loop.ts) — a persistent 15 s tick delivering to Telegram directly, single-instanced by a bound health port rather than a pidfile (a pidfile goes stale after a crash and locks out the restart), ticks **skipped never queued**, and sharing its decision code with the one-shot CLI so the two cannot drift. Same pass fixed a live false alarm: an `EBUSY` mid-replace made the tick fall through to **mock** data and page *"recovered to OK"* during a real 35 °C / 86 % excursion — now the read retries **and** an untrusted reading can no longer move the alert state machine at all. Every state file write went atomic-with-retry (`common/atomic-write.ts`) and every numeric env var NaN-safe (`common/env.ts`). The wall now **probes** the health port instead of printing a hard-coded cadence. **Suite 295/295** | [docs/WATCHDOG.md](docs/WATCHDOG.md) |
| 18 | **Phone panel auto-scroll deadlock fixed** (2026-08-05 PM). Reported from the wall: new Telegram messages landed off the bottom of the phone panel and stayed there, needing a manual scroll every time. Root cause reproduced live, not assumed: the panel lives on the hidden "Live system" tab, and a `display:none` subtree reports `scrollHeight`/`clientHeight`/`scrollTop` as `0` regardless of content. The first tick that renders a real backlog while still hidden computes "at bottom" from that `0/0/0` reading and no-ops the scroll; by the next tick the tab is visible with real geometry but `scrollTop` is stuck at `0` — read as "scrolled away" forever, since nothing ever moves it again. Replaced the `scrollTop`/`scrollHeight` heuristic with an `IntersectionObserver` on an anchor pinned to the end of the thread, plus one forced scroll the first tick the panel is genuinely measured, to break the deadlock at its root. Also fixes the same panel below the 940px stacked-layout breakpoint, where `tg-thread` never has internal overflow and the old assignment was always a no-op independent of this bug. Manual scroll-up is preserved (a new message never yanks the view back down mid-read), and scrolling is instant rather than animated so a burst of several messages in one tick doesn't visibly chase the bottom for seconds afterward. Verified with a headless browser against the live server: reproduced the original bug on the unmodified code first, then confirmed the fix at both a wide and a <940px viewport, confirmed scroll-up-to-read-history holds still, and confirmed no lag under a 20-message burst | [docs/DASHBOARD.md](docs/DASHBOARD.md#design-notes) |
| 19 | **Workload placement audited against NPU/GPU/CPU policy** (2026-08-05 PM), in response to a request to use QUAD to rebalance server workloads. QUAD can't do that profiling run: its own docs already say `profile_device` cannot reach this laptop's Hexagon (remote x86 VM), and the NPU numbers actually in use came from `qnn-net-run`/`qnn-profile-viewer` against the running GenieX server, not QUAD. Audited what's actually placed instead: the one real AI/LLM workload (GenieX/Qwen3-4B) is correctly on the NPU with measured numbers behind it (382±8.3 tok/s prefill vs GPU's outright **FAIL** — `SDKError(Model loading failed)` on any tool-calling request, reproduced in two logs); every other server process (network/storage/compute mocks, environmental I/O, rules, assessment, the wall, the watchdog) is a lightweight Node process with no accelerator-relevant compute, already on CPU by construction. The GPU tier's only realistic future occupant — face identification (`face-npu`/`face-cpu` in the identity ladder) — is architected but not built (no `ACCESS_VISION_SCRIPT` in the repo), so there is nothing to place there yet. **Verdict: current placement already satisfies the stated policy; no rebalancing action available today.** No runtime code changed. **Update 2026-08-06: `face-cpu` has since been built and verified live** (InsightFace buffalo_s via onnxruntime), landing on **CPU** — the non-NPU fallback this audit already anticipated — so the GPU tier still has no occupant and the verdict above is unchanged; see [docs/WORKLOAD_PLACEMENT.md](docs/WORKLOAD_PLACEMENT.md) and [phone/README.md](phone/README.md#the-identity-ladder) | [docs/WORKLOAD_PLACEMENT.md](docs/WORKLOAD_PLACEMENT.md) |
| 20 | **Dashboard redesigned for presentation, plus a demo mode** (2026-08-06). The wall was built for a laptop screen next to the rack; presenting it to a room exposed that directly — small text, thin lines, and a live outcome resting on real conditions (a real leak, a real door) cooperating on cue. Executive overview / Conceptual architecture / Logical architecture got two rounds of type and line-weight increases, a four-colour accent system on the overview cards (cyan/blue/violet/pink, deliberately outside the good/warning/critical status palette so an accent card is never misread as a status), a team section, and an added "Infrastructure" build row describing the synthetic-log-generation MCP path. The live wall split in two: **Live system** is now a 60/40 projector-scale summary (risk verdict, four channel tiles, network/storage/compute, the phone thread) that a room can read from six feet away, while **Live details** keeps the original three-column technical dashboard, unchanged, on its own tab. Added a **Live/Demo toggle** to Live system, defaulting to demo mode on navigation: three scripted scenarios (environmental deviation, door+presence, storage-drops-then-remediates), each a full inbound-instruction → simulated-deviation → outbound-alert story, run on a fixed 10s-scenario / 10s-gap / 30s-pause timeline that loops until toggled off. Demo mode writes only to Live system's own elements (`writeSummaryTile`/`writeSummaryTemp`/`writeSummaryAccess`/`writeSummaryRisk`/`renderFamilyList` in `app.js`, each real-feed call site guarded by `if (!demoMode)`) — Live details renders `/api/stream` unconditionally throughout, verified by diffing its values against the demo script's scripted numbers during a run. Fixed two bugs found by watching a live run rather than just reading the code: the outbound alert could land on no tick at all at a 400ms-tick/10s-window granularity (fixed with an early fire plus a guaranteed fire-on-transition fallback, immune to background-tab timer throttling), and the phone frame's CSS-stretch height fought its own message thread's growth, inflating the whole tab instead of scrolling — replaced with a measured height synced from the left column (`syncPhoneHeight`) so the thread clips and auto-scrolls to newest at the bottom instead | [docs/DASHBOARD.md](docs/DASHBOARD.md#the-six-tabs), [docs/DASHBOARD.md](docs/DASHBOARD.md#demo-mode) |
| 21 | **Wall-side approval panel with the captured photo** (2026-08-06, merged from `face-cpu-phase-a`). The phone was previously the only surface that could actually decide a challenge; the wall showed a one-line "awaiting authorisation" note with no photo and no button. Now the access card carries a full approval panel — the captured photo (served from `GET /api/access/pending-photo`, held in memory only, 404 once decided), a "NOT AUTHORISED" headline reusing the existing verdict text, and Approve/Deny buttons that POST the same `/api/access/approve` route the phone uses, so the wall is a second decision surface for the same challenge rather than a parallel one. A known-arrival banner ("X just got in") renders fresh from `a.verdict`/`a.faces` every tick. `enrol` is disabled in `phone.html` for this demo — a hand-typed name has no real embedding behind it. Lands alongside the CPU face-vision pipeline (SCRFD detect + ArcFace embed) referenced in item 19's update | [docs/DASHBOARD.md](docs/DASHBOARD.md), [phone/README.md](phone/README.md#the-identity-ladder) |
| 22 | **On-device activity inference — a second, much smaller LLM, now running on the UNO Q itself** (2026-08-06). `hermes-sensor-logger` now correlates its own recent sensor history into short `activity-*` log lines (e.g. `activity-possible_fire_risk`, `activity-person_entered_room`) via **SmolLM2-135M-Instruct**, on the board's CPU. Not the agent's brain — a separate, purpose-built classifier for the board's own sensor stream; see [docs/ONDEVICE_ACTIVITY.md](docs/ONDEVICE_ACTIVITY.md) for the full design. Two findings worth flagging here: (1) **the QRB2210 has a real Adreno 702 GPU** (Turnip/Vulkan) that no doc had previously identified — tried for this workload, it crashed under repeated load (`vk::DeviceLostError`) and was ~32× slower on decode even when it didn't, so CPU ships, not GPU; (2) **blind LLM classification from raw sensor text was unreliable** at this model size (it would sometimes echo its own system prompt instead of a label) — fixed by having the deterministic trigger logic supply a suggested label and falling back to it whenever the model's answer isn't a real vocabulary word. QUAD was not usable for profiling this (not connected in this session, and its NPU/QNN tooling doesn't reach this workload regardless — see the doc's "Why not QUAD" section); all numbers here are measured directly on the board over `adb`. **Live-verified on real hardware**, not just the test suite: door+presence+light → `person_entered_room` in 9s, presence-leaving → `person_left_room` in 7s, a warm-breath temperature ramp (24°C→40°C) → `possible_fire_risk`, correctly firing again later in the same ramp once the cooldown expired rather than going silent after one alert. `mcp-tools` suite unaffected, 327/327 | [docs/ONDEVICE_ACTIVITY.md](docs/ONDEVICE_ACTIVITY.md), [uno-q/README.md](uno-q/README.md) |
| 22b | **Dashboard surfaces the on-device activity inference; a new activity now pages the phone directly** (2026-08-06). `activity` log lines were previously invisible on the wall (counted, never streamed — item 22's own follow-up note). First pass added a 5th "Activity" channel tile to Live system/Live details; **superseded same-day** — the tile was removed in favour of pushing every new activity straight to the on-call's phone as its own Telegram message (*"UNO Q detected a possible activity: Person entered room."*), which is more useful for something that just happened than a value sitting on a wall tile. Landed in the existing watchdog path, not a new one: `alert-skill/tick.ts` now also calls `readLatestActivity()` (new, `environmental/file-source.ts`) and compares it against a persisted `lastActivityAt` watermark (new field on `AlertState`) — a plain "have I already said this", not a second cooldown, since `activity.py` already edge-triggers and cooldowns its own inferences at the source. Deliberately **not** run through `evaluateSuppression`: a responder standing at the rack is a reason to withhold an environmental alert they're already looking at, not a reason to withhold "someone just entered the room". What's still on the wall: the pipeline stream renders each activity with a humanized label (`activity-possible_fire_risk` → "Possible fire risk") tagged with a **new, separate** `board-inference` source — deliberately not reusing the laptop's own `inference` tag (its Qwen3-4B risk assessment), so the wall never conflates which model, or which tier of hardware, produced a given line — and the raw Sensor-log feed shows the same humanized text. `humanizeActivity`/`activityStatus` (the fire/leak/risk keyword heuristic) now live once in `src/common/activity.ts`, shared by the dashboard and the watchdog; `public/app.js` keeps its own copy, same as it already does for `DEVICE_EVENT_LABELS`/`EVENT_LABELS`, since the browser has no module system to share with. Also updated: the Executive overview's "what we built" table, the Conceptual architecture UNO Q card and component list, the Logical architecture's stage 1 (on-device correlation is a distinct tier from stage 4's laptop assessment, called out rather than conflated), and the Disclosure card. 8 new/changed tests across `state-store.test.ts` and `tick.test.ts` (333/333 total); verified live against the actual built CLI (`dist/alert-skill/check-environmental.js`) with a synthetic log — first run pushes the message, an unchanged rerun correctly says nothing | [docs/DASHBOARD.md](docs/DASHBOARD.md), [docs/WATCHDOG.md](docs/WATCHDOG.md) |

## Leftovers — next session starts here (as of 2026-08-05 PM)

0. **Cut over to the watchdog loop** (~2 min, deliberately left manual because it stops the
   current alerting path and mis-sequencing it double-pages the on-call):
   `hermes cron delete f47e35e60c09` then `.\scripts\install-autostart.ps1 -Only watch`, then
   `curl.exe -s http://127.0.0.1:7789/health` to confirm ticks climbing and `canDeliver: true`.
   The installer refuses to run while that cron job is enabled, so the order matters.
   [docs/WATCHDOG.md §5](docs/WATCHDOG.md#5-running-it).

1. **§4 rehearsal screenshots** (~10 min, needs the user at the GUI while the agent drives
   load): Task Manager → Performance → NPU graph during generation; HWiNFO sensors panel
   (power rails); QAIRT Visualizer op view (inputs ready in `bench/artifacts/out/`).
   Load driver, repeatable ~60 s NPU burn:
   `python llm-serving-bench/prefill_long.py --reps 391 --label screenshot-load`.
2. **Gated Qwen3.5-4B candidate test** (optional; research complete, decision rule in
   [docs/MODEL_ALTERNATIVES.md](docs/MODEL_ALTERNATIVES.md)): first check whether GenieX's
   bundled llama.cpp has Gated-DeltaNet ops (expected: no → CPU fallback → skip); if
   plausible, `python llm-serving-bench/bench.py --model unsloth/Qwen3.5-4B-GGUF:Q4_0
   --modes npu` — swap only if it beats the baseline's modeled agent iteration AND passes
   the tool-call gate AND survives one live Hermes MCP turn. Baseline stays otherwise.
3. **Environment facts that WILL bite you** (details: RESULTS.md §Stability findings):
   never run a second NPU/Hexagon process next to production — it wedges the DSP and can
   take production down with it; two 64K servers exceed the 32 GB commit limit — dedicated
   bench/energy servers use `--nctx 16384`; an external manager kills/restarts geniex by
   image name (production PID churns — check `Get-NetTCPConnection -LocalPort 18181` before
   assuming anything); HWiNFO ARM64 publishes **no** SM2 shared memory — use CSV logging +
   `energy.py --csv`; production start command (with `--skip-update` + log redirect) is in
   RESULTS.md §Reproduce and at the end of every `bench.py` run.

## Locked architecture decisions (from the audit + spike)

- **Suppression is a deferral, never a cancellation.** While a page is held, `lastStatus` is not advanced, so the crossing fires the moment the responder leaves. The escalation baseline is the status **when the hold began** (`heldPage.heldStatus`), not the last status paged at — using the latter made every cold-start alert an "escalation" and the feature never engaged. And it **fails open**: suppression depends on the dashboard writing `access.json`, so a stale file pages regardless.
- **Physical access**: identity is a **swappable adapter** (face-npu / face-cpu / detect-only / qr-badge), exactly like the messaging gateway. The loop, matrix and audit trail are identical at every rung, so a failed rung costs a capability, not the demo. Default is the *least* capable rung that works. **Biometric templates never leave the laptop and source images are never persisted** — GDPR treats face templates as special-category data, so this is what makes the feature deployable, not merely fast.
- **Approval**: notification may go over the cloud relay; **the decision may not**. Physical access is authorised on the local page over the tailnet only.
- **Hermes brain**: GGUF **Q4_0** via `geniex serve --nctx 65536 --compute npu` — the only config satisfying Hermes's hard 64K minimum *and* tool calling *and* NPU offload. Q4_K_M silently falls back to CPU — precision is load-bearing.
- **qairt W4A16 bundle**: benchmark/demo beat only (`geniex chat`, tok/s harness, QUAD profiling after session restart).
- **Hermes install**: native Windows-ARM64 (`install.ps1`, Tier 1) — the docs' WSL2 path is obsolete. Node 26 requirement landed 2026-08-02; expect installer churn.
- **Telegram**: fine for the demo; pitch language must stay "zero cloud LLM calls", never "air-gapped".
- **UNO Q**: environmental data source, **and** (since 2026-08-06) a small on-device classifier — SmolLM2-135M on CPU turning its own sensor history into `activity-*` log lines (item 22). Still not the agent's brain: no NPU on QRB2210, and a real Adreno 702 GPU was measured and lost to CPU for this workload too. The bogus "1 TOPS INT8" wording is fixed everywhere — 2026-08-03. Sensors are external Modulinos (Buttons/Distance/Thermo on Wire1).

## NEXT — in order

1. ~~**Install Hermes Agent**~~ ✅ **DONE 2026-08-03** — native install, exit 0;
   `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`.
2. ~~**Wire Hermes → GenieX**~~ ✅ **DONE 2026-08-03** — `config.yaml`: `provider: custom`,
   `base_url: http://127.0.0.1:18181/v1`, default model
   `unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0`, `context_length: 65536`.
3. ~~**Register the four MCP servers**~~ ✅ **DONE + END-TO-END VERIFIED 2026-08-03** —
   `hermes -z "check the rack-b1→zone-east link"` booted (no 64K rejection), spawned the MCP
   servers, tool-called through the NPU-offloaded endpoint, and answered with live mock data
   ("connected, 9.54 ms latency, 0.26% packet loss, ok"). The full pitch chain works.
4. **Telegram gateway** — ✅ wired and outbound-verified 2026-08-03 (token in `.env`, the on-call
   user's Telegram ID allowlisted + set as home channel, gateway detached, `hermes send` delivered
   to phone).
   **Two production bugs found and fixed during the round-trip test:**
   - **GenieX streaming incompatibility (the "stuck" turn):** `geniex serve` streaming responses
     end without `finish_reason`/tool-call frames → Hermes discards every completed 2-min
     response as a mid-stream drop and retries forever. Fixed via a documented local patch in
     `hermes-agent/agent/conversation_loop.py` honoring `HERMES_FORCE_NONSTREAM=1` (set in
     `.env`). Non-streaming responses are handled correctly (verified: full one-shot turn with
     env tool completed, 259s). NOTE: `hermes update` would revert this patch — don't update.
   - **Latency**: ~2 min per agent iteration = full-prompt re-prefill at ~280 tok/s (NPU).
     Telegram toolset trimmed to `[terminal, skills, cronjob]`. Compute-mode benchmarks:
     prefill NPU 12.5s / hybrid 18.5s / **GPU 5.2s + ~110 tok/s decode, but GPU mode
     reproducibly FAILS tool-enabled requests** (`SDKError(Model loading failed)` — GenieX
     preview bug, file upstream) → NPU stays. `cache_prompt` not honored (~18% only).
     Expect 2–4 min per phone reply; scope demo questions to one tool call.
5. ~~**Close the UNO Q data gap**~~ ✅ **DONE 2026-08-03** — new `file-source.ts` reads the
   pushed log (newest line → temp/humidity; leak events within a 5-min window → `leakDetected`,
   so leaks recover; 1h staleness guard falls through to SSH → mock with the reason chain).
   Wired into Hermes via `UNOQ_SENSOR_LOG` env on the environmental server. 9 new tests;
   suite 52/52 green (also fixed two pre-existing wall-clock test flakes in the mocks).
   Verified live: stale 2.7h-old log correctly refused → mock + clear reason.
6. ~~**Cron alert skill**~~ ✅ **DONE 2026-08-03, with a design upgrade** — used Hermes cron's
   `--no-agent --script` watchdog mode instead of the agent-session skill: the wrapper — originally
   a bash `environmental-watch.sh`, **now `environmental-watch.py`** in
   `%LOCALAPPDATA%\hermes\scripts\` (that is `HERMES_HOME` here; there is no `~/.hermes`) — runs
   `check-environmental.js` on a cron schedule and prints only on ALERT/recovery (empty stdout =
   silent), `--deliver telegram`. **Superseded 2026-08-05 PM by the 15 s watch loop — see item 17;
   run one watchdog, not both.** Zero LLM cost
   per tick, so the cadence doesn't starve interactive queries (an agent-session tick costs
   ~3 min of NPU). The skill doc's `--deliver` warning applied to *agent* replies; in no-agent
   mode empty-stdout-silence makes `--deliver` correct. check-environmental.js now self-locates
   the pushed sensor log (repo-relative default).
   The installed `environmental-watch` skill remains for the demo narrative/manual runs.
   Demo note: expect a one-time "recovered to OK" push ~5-10 min after any leak test —
   that's the edge-triggered recovery working, not a bug.

   ⚠️ **The 2026-08-03 "end-to-end verified" claim was wrong, and the watchdog was dead for ~50
   minutes** (9 consecutive failed ticks, 22:35→23:17). Fixed 2026-08-04. Post-mortem, because the
   *way* it was wrong matters more than the bug:
   - **Bug**: Hermes picks a script interpreter by file *extension*
     (`hermes-agent/cron/scheduler.py`) — `.sh` → `shutil.which("bash")`. On this laptop `bash`
     resolves **only** to WSL launchers (`C:\Windows\system32\bash.exe`, WindowsApps alias) and the
     default WSL distro is `docker-desktop`, which has no `/bin/bash`. Every tick died with
     `WSL (9 - Relay) ERROR: ... execvpe(/bin/bash) failed`, and Telegram got a *failure* notice
     instead of the predicted "recovered to OK" push.
   - **Why the first run passed and every later one failed — mechanism NOT fully established.**
     What's certain: the 22:29:40 run executed the script successfully (it produced the CRITICAL
     alert text), and every tick from 22:35:09 on failed in WSL. The gateway did **not** restart
     between them — PID 18416 started 19:53:36 and served both — so a simple "different process,
     different PATH" story does not hold. `bash` resolved to something usable on the first run and
     to WSL afterwards; the plausible causes are `os.environ["PATH"]` being mutated inside the
     long-lived gateway, or the default WSL distro flipping to `docker-desktop` when Docker Desktop
     started. **Don't repeat the guess I first wrote here** (that `hermes cron run` uses the
     invoking shell's PATH) — the timeline contradicts it. The actionable lesson stands regardless:
     `shutil.which("bash")` is not stable on this machine, so the fix removes the dependency
     entirely rather than trying to pin it.
   - **Fix**: wrapper rewritten in Python — [`mcp-tools/cron/environmental-watch.py`](mcp-tools/cron/environmental-watch.py),
     now version-controlled (the `.sh` existed *only* in `%LOCALAPPDATA%`, so nothing in the repo
     could restore it). Hermes runs any non-`.sh` extension with its own bundled Python, so there is
     no PATH dependency left. `node` is also resolved with an absolute fallback. Infrastructure
     failures now exit non-zero **on purpose** so Hermes surfaces them — a silently-dead watchdog is
     what let this hide for an evening.
   - **Rule going forward: a single successful run is not verification.** Confirm the *scheduled*
     path: wait for `next_run_at` to pass and check `jobs.json` shows `last_status: ok`, ideally
     across two consecutive ticks. Full procedure: [docs/E2E_TEST.md](docs/E2E_TEST.md).
   - Second trap found while re-testing: priming the alert state with PowerShell 5.1
     `Set-Content -Encoding utf8` writes a **UTF-8 BOM**, which makes `JSON.parse` fail in
     `readState`; it silently defaults to `lastStatus: "ok"` and the recovery alert never fires.
     Write state files with `[System.IO.File]::WriteAllText(path, json, UTF8Encoding($false))`.
7. ~~**Benchmarks — §3 per-op pass**~~ ✅ **DONE 2026-08-03** — all 8 target graphs of the W4A16
   bundle profiled on Hexagon v73, `rc=0`; results + method + caveats in
   [docs/BENCHMARKS.md](docs/BENCHMARKS.md), harness in [`bench/`](bench/).
   **Audit risk P2 is closed favourably: the profiler does not reject LLM bundles**, so the
   tok/s-harness fallback is not needed. Headlines: prefill **254 tok/s** @cl4096 (cross-validates
   the ~280 tok/s spike figure), decode **4.6 tok/s** @cl4096 → **9.2** @cl512; the LM head
   (`node_linear_72`, 2560→151,936) is the hottest op in the network at **6.03 M cycles/token,
   ~26× the next op**; context load 5.05 s; 92.5% of measured time is on-accelerator.
   Three things to know:
   - **The W4A16 bundle is NOT the performance path** — it decodes *slower* than the Q4_0 GGUF that
     actually serves Hermes (~15–16 tok/s). Don't let the slide imply otherwise; its value is that
     it's per-op profilable, which the GGUF path isn't.
   - Two prerequisites nobody had documented: the bundle's blob is v3.3.4 so the installed **QAIRT
     2.32.6 backend refuses it** (must borrow GenieX's 2.45 libs), and each `part*.bin` holds
     **10 graphs** needing per-graph input plumbing.
   - `profile_workload` is **unusable** here (MCP server is a remote x86 VM, no NPU, can't see local
     disk) and `profile_device_report` has a **bug**: it reports a successful run as `FAILED`
     because it parses stdout for snpe-style timings that `qnn-net-run` never prints.
   Still open from §1/§2 as of 2026-08-05 PM: only the §4 screenshots and the phone-vs-laptop
   stretch. ~~§1 served throughput~~, ~~the long-context/64K timing~~, and ~~§2 Joules/query~~
   are all ✅ done — merged table, prefill-vs-context curve, the ~60K NPU crash ceiling, and
   the energy table (**NPU 471 J/query measured at the 12.5K agent shape; ~8.7× more energy
   per token on CPU; inference adds just +6.3 W system power on NPU vs +21.3 W on CPU**) in
   [llm-serving-bench/RESULTS.md](llm-serving-bench/RESULTS.md). Energy method note: HWiNFO
   ARM64 8.50 does **not** publish SM2 shared memory — `energy.py --csv` integrates a HWiNFO
   CSV sensor log instead (Start Logging in the Sensors window).
8. ~~**Doc hygiene**~~ ✅ **DONE 2026-08-03** — see done-table row 9; all sub-items applied,
   including softening "only path with genuine NPU acceleration". The last open sub-item —
   **verify the HolmesGPT/K8sGPT competitor claim** — is now ✅ **researched and sourced
   (2026-08-03 evening)**: K8sGPT = pre-built analyzers + LLM explain, no incident learning;
   HolmesGPT = runbook-driven, no persistent learning documented; Hermes L4 self-written skills
   confirmed in Nous docs. Sourced wording now lives in
   [docs/HARDWARE_UTILIZATION.md](docs/HARDWARE_UTILIZATION.md) § Demo beats.
9. ~~**Triage REVIEW_AND_SENSOR_PLAN**~~ ✅ **CR-1/CR-2/CR-3/CR-5 + S-1 DONE & LIVE-VERIFIED
   2026-08-03 (late bench session)** — see
   [docs/REVIEW_AND_SENSOR_PLAN_2026-08-03.md](docs/REVIEW_AND_SENSOR_PLAN_2026-08-03.md) for IDs:
   - **CR-1**: board now emits a `sensor_tick` every 10s (second Bridge channel; buttons unchanged);
     deployed via `arduino-app-cli app restart` (no sudo needed) and verified flowing.
   - **CR-2**: `distanceMm` surfaced end to end — watched it track hand movement 14→150mm live.
   - **S-1 (level leak)**: `UNOQ_LEAK_DISTANCE_MM` threshold logic in `file-source.ts`; verified
     live against a real reading → `leakDetected: true, leakVia: "level"`, alert message renders
     "water-level distance 52mm, LEAK DETECTED (water level rising) (real sensor)". Threshold ships
     **unset (off)** — per the emulation framing, button C stays the primary demo trigger; the
     level path is a calibrated-when-wanted capability (tray + opaque float, threshold below the
     empty-tray baseline). 8 new tests; suite 60/60.
   - **CR-3/CR-5**: tool description rewritten (three-source chain, distanceMm, leakVia); NaN env
     guard added. Staleness tightened to **180s** in config.yaml + watchdog wrapper.
   - **New transport fallback**: `uno-q/pull_sensor_log.ps1` adb-pulls the log over USB every 10s —
     used when the board has no WiFi/tailnet (tonight's bench; also the most reliable demo-table
     transport).
   - ⚠️ **Two gotchas found live** (documented in `uno-q/hermes-sensor-logger/README.md` + memory):
     the board has **no RTC battery** — off-network power-ups boot at 1970, timestamps go wrong,
     and the staleness guard (correctly) refuses the data; fix via the docker `--user 0
     --cap-add SYS_TIME` one-liner. And the board's **Tailscale is logged out** — re-auth at the
     venue Friday morning, don't discover it on stage.
   - Still open from the review: CR-4 (moot in watchdog mode), CR-6, CR-7, CR-8, S-2 (rate-of-rise),
     S-3 (dew point), S-4 (ASHRAE thresholds), S-5 (buttons as ack/report).
10. **Two chosen demo beats + evidence plan** (from the 2026-08-03 self-review; ratings internal at
    the QUAD workspace root, methodology public in
    [docs/BENCHMARK_PLAN.md](docs/BENCHMARK_PLAN.md)):
    - **Beat 1 — "same question, two brains"**: identical env query on `--compute cpu` vs
      `--compute npu`, Task Manager NPU graph + HWiNFO power sampling on screen, Joules/query
      delta reported (X1 can't expose NPU watts directly — methodology per arXiv 2606.11257, same
      silicon). WiFi-off proof folds into the NPU leg.
    - **Beat 2 — real water-pour leak (S-1)**: ✅ **plumbing done + live-verified** (NEXT 9) — the
      level path fires from real readings. Remaining for the stage version: the physical rig
      (tray + opaque float), calibrate `UNOQ_LEAK_DISTANCE_MM` against the empty tray, and one
      full rehearsal ending in a Telegram push. **Demo framing per team decision: this is an
      emulated datacenter** — buttons are the incident-injection panel; the pitch line is "you
      can't flood a datacenter on stage — the incidents are injected, the detection/reasoning/
      paging pipeline is 100% real." Water rig is the optional garnish, button C the primary
      trigger.
    - Skill-self-writing: **record as backup video Thursday**; live only if stable in 3 straight
      rehearsals. Voice, phone-side inference, live dashboard: dropped for this week.
      *(The live dashboard decision was since reversed — it shipped, NEXT-table row 11.)*
    - Suggested order Tue→Fri: QUAD profile attempt (timebox 2h) + bench harness + S-1 bench test →
      cron skill + CR-1/CR-2 + BENCHMARKS.md → rehearse ×3 + freeze → README pass + submit early.

11. **NEW Beat 3 — "watch it not page me"** (2026-08-05, from the access sentry). The most
    memorable thing this system can do in front of an audience, and it needs no new hardware:
    1. Rack is at WARNING. On-call is elsewhere. The phone pages.
    2. Enrol the volunteer (one field, one tap — consent as a **visible, deliberate act**), then have
       them stand at the sensor. Verdict flips to `expected`; the wall says the page is held.
    3. Run the watchdog again: **silent.** "It knows you're standing in front of it."
    4. They walk away → the alert arrives, marked *"held while the on-call was on site; sending
       now."* It was deferred, never dropped.
    5. Optional kicker: escalate while they stand there — **it pages anyway.**
    Rehearse the enrol step; it is the only part touching a stranger's data.
    **Unblocked 2026-08-07 — consent resolved below.**

12. **Consent policy for the roster — RESOLVED 2026-08-07.** Three consenting team members were
    pre-enrolled on 2026-08-06 (the roster behind the live 0.85/0.79 validation matches); stub
    mode remains the default for anyone unenrolled, and live volunteer enrolment stays optional
    as a demo beat (consent as a visible act). No stranger's biometrics are captured without the
    on-stage consent step.

## Open risks still live

- ~~**Long-context prefill latency untested**~~ ✅ **closed 2026-08-05 PM — measured directly**
  (curve + crash forensics in [llm-serving-bench/RESULTS.md](llm-serving-bench/RESULTS.md)):
  12.5K tok → 60.9 s (206 tok/s, the real Hermes request shape → honest agent iteration ≈ 68 s);
  31.8K tok → 293 s (108 tok/s) — the worst case Hermes can send (compression fires at 32K),
  inside the 900 s stale ceiling with 3× headroom, which retro-validates the
  `providers.custom.stale_timeout_seconds: 900` fix as demo-critical (180 s would kill every
  near-threshold turn). **New, sharper risk found in its place:** a **~60K prefill crashes
  GenieX v0.3.18 on NPU** (`dspqueue_read failed: 0x00000072`) even though `--nctx 65536` is
  accepted — a true 64K prompt is unreachable today. Production is guarded by
  `compression.threshold: 0.5` (32K) — **do not raise it**. Also reproduced 2/2: a second
  Hexagon process (benchmarks on port 18191) can wedge the DSP and take the production server
  down with it — bench only when production may be restarted afterwards (recovery: restart
  geniex, ~20 s; it now runs with `--skip-update` and logs to
  `llm-serving-bench/serve-production-18181.log`). Demo guidance: reset the Telegram session
  before demoing → ~1 min turns; the 32K ceiling costs ~5 min/turn.
- **~15–16 tok/s decode** — keep agent replies terse via system prompt or demos drag.
- **Hermes Node 26 migration churn** (landed 2026-08-02) — pin whatever the installer gives; don't
  `hermes upgrade` mid-week.
- ~~**quad-profile on LLM bundles unverified** (P2)~~ ✅ **closed 2026-08-03** — the profiler does
  not reject LLM bundles; all 8 graphs ran. No fallback needed. See
  [docs/BENCHMARKS.md](docs/BENCHMARKS.md). New, smaller risk in its place: profiling the bundle
  depends on **borrowing GenieX's QAIRT 2.45 backend libs** (the installed 2.32.6 refuses the v3.3.4
  blob), so it breaks if GenieX is updated or uninstalled — another reason to pin v0.3.18.
- **GenieX is a Developer Preview** — pin v0.3.18, don't auto-update during hack week.
- **Suppression needs the dashboard alive.** The cron watchdog reads `.state/access.json`, which
  only the dashboard writes. If the wall is not running, that file goes stale and the watchdog
  pages normally — correct (fail open), but it means **step 6 is now a dependency of the step 5
  demo beat**, not an optional display. Start it before rehearsing.
- ~~**The phone's 8 Elite NPU is idle.**~~ ✅ **closed 2026-08-06** — measured (prefill
  1,918 ± 16.9 tok/s, decode 23.1 ± 1.3, `genie-t2t-run` over `adb`) and then wired in as the
  live **compute failover**: dead GenieX (TCP connect refused) → the phone's NPU answers the
  Telegram question, labeled degraded, **12.0 s** message→delivered (n=1; the phone leg alone
  is **7.1 ± 0.7 s** over n=5, 54% of it model load — 2026-08-07)
  ([hermes-hooks/README.md](hermes-hooks/README.md)). (The identity rung that plan also
  proposed shipped separately, as `face-cpu` on the laptop's CPU, not the phone's NPU — see
  [phone/README.md](phone/README.md#the-identity-ladder).)
- ~~**Nothing is committed.**~~ ✅ **closed 2026-08-04** — the repo lives on GitHub as two
  synced public mirrors (`aryanil89/SMH-Hermes`, the submission URL, and
  `chrisxgould/SMH-Hermes`), committed and pushed continuously since; the secret sweep is
  enforced by `.gitignore` and the checklist in [SUBMISSION.md](SUBMISSION.md).
