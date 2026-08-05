# SMH-Hermes — Progress & Plan (living doc)

Last updated: **2026-08-05**. One file for where the project stands, what's proven,
and what's next. Detail lives in the linked docs; this is the map.

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

| 13 | **Access sentry — claims made true** (2026-08-05), after an independent review. **The centerpiece was dead code**: `shouldSuppressPage` had zero call sites outside its own test and nothing in the paging chain imported `access/`, so "a known responder on site stops it paging you" changed a caption on the wall and pages went out regardless — refutable live by a judge saying *"show me it not paging."* Now wired via `alert-skill/suppress.ts` and verified end to end: on site → silent; walk away → the held page fires; escalate → pages anyway; stale state → pages anyway. Also fixed from the same review: a POST rejection could **kill the whole server** (unguarded `void` dispatch + a routine Windows file lock), a stale board **falsified the audit trail** (filed "presence ended with no decision" when the feed died), and stored **XSS** on the approval terminal. **58 access tests, suite 242/242** | [docs/DASHBOARD.md](docs/DASHBOARD.md) §Access |

## Locked architecture decisions (from the audit + spike)

- **Suppression is a deferral, never a cancellation.** While a page is held, `lastStatus` is not advanced, so the crossing fires the moment the responder leaves. The escalation baseline is the status **when the hold began** (`heldPage.heldStatus`), not the last status paged at — using the latter made every cold-start alert an "escalation" and the feature never engaged. And it **fails open**: suppression depends on the dashboard writing `access.json`, so a stale file pages regardless.
- **Physical access**: identity is a **swappable adapter** (face-npu / face-cpu / detect-only / qr-badge), exactly like the messaging gateway. The loop, matrix and audit trail are identical at every rung, so a failed rung costs a capability, not the demo. Default is the *least* capable rung that works. **Biometric templates never leave the laptop and source images are never persisted** — GDPR treats face templates as special-category data, so this is what makes the feature deployable, not merely fast.
- **Approval**: notification may go over the cloud relay; **the decision may not**. Physical access is authorised on the local page over the tailnet only.
- **Hermes brain**: GGUF **Q4_0** via `geniex serve --nctx 65536 --compute npu` — the only config satisfying Hermes's hard 64K minimum *and* tool calling *and* NPU offload. Q4_K_M silently falls back to CPU — precision is load-bearing.
- **qairt W4A16 bundle**: benchmark/demo beat only (`geniex chat`, tok/s harness, QUAD profiling after session restart).
- **Hermes install**: native Windows-ARM64 (`install.ps1`, Tier 1) — the docs' WSL2 path is obsolete. Node 26 requirement landed 2026-08-02; expect installer churn.
- **Telegram**: fine for the demo; pitch language must stay "zero cloud LLM calls", never "air-gapped".
- **UNO Q**: environmental data source only (no NPU on QRB2210; the bogus "1 TOPS INT8" wording is now fixed everywhere — 2026-08-03); sensors are external Modulinos (Buttons/Distance/Thermo on Wire1).

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
   `check-environmental.js` every 5 min and prints only on ALERT/recovery (empty stdout = silent),
   `--deliver telegram`. Zero LLM cost
   per tick, so 5-min cadence doesn't starve interactive queries (an agent-session tick costs
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
   Still open from §1/§2: Task Manager NPU graph + HWiNFO Joules/query, a real 64K prefill timing,
   and the phone-vs-laptop stretch.
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
    memorable thing this system can do in front of a judge, and it needs no new hardware:
    1. Rack is at WARNING. On-call is elsewhere. The phone pages.
    2. Enrol the judge (one field, one tap — consent as a **visible, deliberate act**), then have
       them stand at the sensor. Verdict flips to `expected`; the wall says the page is held.
    3. Run the watchdog again: **silent.** "It knows you're standing in front of it."
    4. They walk away → the alert arrives, marked *"held while the on-call was on site; sending
       now."* It was deferred, never dropped.
    5. Optional kicker: escalate while they stand there — **it pages anyway.**
    Rehearse the enrol step; it is the only part touching a stranger's data.
    **Blocked on the consent decision below.**

12. **Consent policy for the roster — OPEN, blocking any face capture.** Nobody is enrolled and no
    consent has been obtained. Badge mode needs no biometrics and is the working default, so
    nothing else is blocked. Decide before Friday: enrol judges live (better beat, consent is
    visible), pre-enrol consenting team members, or badge-only.

## Open risks still live

- **Long-context prefill latency untested** — a real 64K prompt has never been timed; test before
  demoing long sessions (P0-adjacent).
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
- **The phone's 8 Elite NPU is idle.** The phone is the authorisation surface, the rack camera and
  the identity store — but no inference runs on it. This is a real gap against the 40-point
  resource-utilisation bucket and the honest answer if a judge asks. The measurement (not the
  feature) is a ~4h `adb` timebox where both outcomes are publishable; deferred to Thursday
  behind rehearsal. See [docs/PHONE_PLAN_2026-08-05.md](docs/PHONE_PLAN_2026-08-05.md).
- **Nothing is committed.** Two sessions have been building all week and the working tree is the
  only copy. A checkpoint commit + push, with a secret sweep, is overdue.
