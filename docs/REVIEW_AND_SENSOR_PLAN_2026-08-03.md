# Code Review + Sensor Plan — 2026-08-03

> **Superseded detail (2026-08-05):** the level-leak path verified below later went inert — the
> board stopped emitting `distance_mm` on periodic `sensor_tick` lines, so `UNOQ_LEAK_DISTANCE_MM`
> is **demoted from the demo** and **Button C is the leak trigger**
> ([mcp-tools/README](../mcp-tools/README.md) § environmental). The rest of the status note stands.

**Status update (late 2026-08-03): CR-1, CR-2, CR-3, CR-5 and S-1 are implemented and
live-verified** — see PROGRESS.md NEXT 9 for the evidence trail (periodic `sensor_tick`,
`distanceMm` end-to-end, level-leak via `UNOQ_LEAK_DISTANCE_MM` with `leakVia`, NaN env guard,
180s staleness, USB adb-pull transport fallback). Still open: CR-4 (moot in watchdog mode),
CR-6/7/8, S-2/S-3/S-4/S-5. Original review text below is unchanged.

**Original status: proposal. Nothing here is implemented.** This is a staging doc — findings and ideas with
stable IDs so they can be cherry-picked into [../PROGRESS.md](../PROGRESS.md)'s NEXT list and
[HARDWARE_UTILIZATION.md](HARDWARE_UTILIZATION.md) without re-deriving the reasoning. Each item
carries a **merge target**. Delete this file once everything is either merged or explicitly dropped.

Scope reviewed: [../mcp-tools/src/](../mcp-tools/src/) (all 4 servers, environmental sources, alert
skill, mocks, common) and [../uno-q/hermes-sensor-logger/](../uno-q/hermes-sensor-logger/)
(`sketch.ino`, `main.py`). Tests at review time: **52/52 green**.

---

## 1. Code review

### Rating: 8/10 — well above typical hackathon quality

Genuine strengths, worth preserving under time pressure:

- **Result types instead of exceptions.** [file-source.ts:38-40](../mcp-tools/src/environmental/file-source.ts#L38-L40)
  returns `{ok:true,reading} | {ok:false,reason}`, and the never-throws / never-hangs contract in
  [source.ts:28-32](../mcp-tools/src/environmental/source.ts#L28-L32) holds all the way down. A demo
  cannot die from an unplugged board.
- **Testability designed in, not bolted on** — injectable clock (`opts.now`), injectable SSH
  transport (`opts.exec`), and [`decideAlert`](../mcp-tools/src/alert-skill/decide-alert.ts#L38) is a
  pure function. That is *why* the 52 tests are meaningful rather than decorative.
- **Leak modelled as a time-windowed incident with recovery**, not a latch on the last line
  ([file-source.ts:113-124](../mcp-tools/src/environmental/file-source.ts#L113-L124)) — semantics were
  thought about, not just plumbing.
- **Tolerates a truncated trailing line** because `scp` can land mid-append
  ([file-source.ts:56-58](../mcp-tools/src/environmental/file-source.ts#L56-L58)).
- **stdout discipline** documented and observed in
  [server-helpers.ts:11-12](../mcp-tools/src/common/server-helpers.ts#L11-L12) — the classic MCP
  footgun, correctly avoided everywhere.
- **`fallbackReason` chains** let the agent *explain* why it is on mock data. Honest by construction,
  and consistent with the project's "no fabricated results" stance.

### Findings

| ID | Sev | Finding | Fix | Merge target |
|---|---|---|---|---|
| **CR-1** | **High** | **Sensor data only reaches the laptop on a button press.** [sketch.ino:86](../uno-q/hermes-sensor-logger/sketch/sketch.ino#L86) — `Bridge.notify` sits inside the rising-edge branch; there is no periodic sample. With the 1-hour staleness guard at [file-source.ts:104](../mcp-tools/src/environmental/file-source.ts#L104), the environmental tool silently degrades to mock unless a human keeps pressing buttons. This undercuts the "real sensor data" claim more than anything else in the codebase. | Timer-driven `Bridge.notify("sensor_tick", …)` every 10–30s; keep button presses as a separate event channel. ~5 lines in the sketch + a second `Bridge.provide` in `main.py`. | PROGRESS NEXT (new item, **do first** — S-1..S-3 all depend on it) |
| **CR-2** | **High** | **`distance_mm` is collected then discarded.** [main.py:25](../uno-q/hermes-sensor-logger/python/main.py#L25) writes it and [file-source.ts:15](../mcp-tools/src/environmental/file-source.ts#L15) types it, but nothing surfaces it — `FileReading` and `EnvironmentalReading` have no distance field. The third sensor's data already reaches the laptop and is thrown away. | Add `distanceMm` to `EnvironmentalReading`/`FileReading` and to the tool response. | PROGRESS NEXT; unblocks **S-1** |
| **CR-3** | **High** | **Tool description is stale, and a tool description is prompt text.** [environmental-server.ts:11](../mcp-tools/src/servers/environmental-server.ts#L11) tells the model real data is gated on `UNOQ_HOST`, but [source.ts:41](../mcp-tools/src/environmental/source.ts#L41) prefers `UNOQ_SENSOR_LOG`. The LLM reads this to decide how to use the tool *and* how to explain itself to the user — worse than a stale comment. | Rewrite the description to match the three-source chain; mention `distanceMm`, `lastEvent`, `ageSeconds` once they exist. | immediate, low risk |
| **CR-4** | Med | **Alert state is persisted before delivery.** [check-environmental.ts:50](../mcp-tools/src/alert-skill/check-environmental.ts#L50) writes `lastAlertedAt`, *then* prints the message for Hermes to send. A delivery failure is therefore swallowed by the 1-hour cooldown — at-most-once alerting. | Either write state only after confirmed delivery, or persist a `delivered:false` flag and retry on the next tick. | PROGRESS NEXT item 6 (cron alert skill) |
| **CR-5** | Med | **A malformed env var silently disables the staleness guard.** [file-source.ts:73](../mcp-tools/src/environmental/file-source.ts#L73): `UNOQ_LOG_MAX_AGE_S=abc` → `Number(...)` is `NaN`, and `ageSeconds > NaN` is `false`, so **any** age passes as fresh. Same pattern on the leak window at line 74. | Parse via a helper that falls back to the default unless `Number.isFinite`. | immediate, low risk |
| **CR-6** | Low | **Mock readings can fire real pages.** The alert path doesn't distinguish `source: "mock"`. Message text is honest about it, but a fabricated reading can wake someone. | Make it a deliberate policy: either suppress alerts on mock, or prefix `[MOCK]`. Decide, don't leave implicit. | PROGRESS NEXT item 6 |
| **CR-7** | Low | Sensor log grows unbounded and is fully re-read + re-parsed on **every** tool call; `parseLine` runs up to twice per line. Fine at hack scale, degrades over days. | Read the tail only, or rotate on the board side. | backlog |
| **CR-8** | Low | `raw_line` snake_case breaks house camelCase ([file-source.ts:117](../mcp-tools/src/environmental/file-source.ts#L117)). `showReadout()`'s blocking `SCROLL_LEFT` plus `delay(800)` is the real reason presses feel dropped — acknowledged in comments, but CR-1's timer makes it worse if not addressed. | Rename; consider non-blocking matrix updates. | backlog |

### Design notes (not defects)

- `decideAlert` never reports **de-escalation** (critical → warning): `crossedWorse` is false and
  `sameBadLevel` is false, so it stays silent while still updating `lastStatus`. Defensible, but
  a partial recovery is invisible. Worth a conscious decision.
- Mock generators are correctly seeded via `mulberry32`; the two test flakes fixed on 2026-08-03 were
  wall-clock `generatedAt` leaking into `toEqual`, not RNG non-determinism.

---

## 2. Sensor plan

### Confirmed hardware capability

| Module | Part | What it actually gives you |
|---|---|---|
| Modulino **Thermo** | HS3003 | Temperature **and relative humidity**. Accuracy quoted as ±0.2 °C by one source and "±0.5 °C typical" by another — **unresolved, verify against the datasheet before printing a number.** |
| Modulino **Distance** | VL53L4CD (ToF) | **10 mm – 1300 mm**, output already in millimetres. |
| Modulino **Buttons** | 3 × momentary | Currently faking `door_open` / `light_on` / `leak_detected`. |

### Proposals, in recommended order

| ID | Idea | Impact | Effort | Depends on |
|---|---|---|---|---|
| **S-1** | **ToF becomes a real leak sensor** (water level in a drip tray) | ★★★ | ~1h | CR-1, CR-2 |
| **S-2** | **Rate-of-rise thermal alerting** (dT/dt), not bare thresholds | ★★★ | ~1–2h | CR-1 |
| **S-3** | **Dew point** derived from T + RH | ★★ | ~30m | CR-1 |
| **S-4** | **Ground thresholds in ASHRAE TC 9.9** and say so | ★★ | ~15m | — |
| **S-5** | **Buttons become acknowledge / report / snapshot** | ★★ | ~1h | S-1 |
| **S-6** | ToF as rack-door-ajar detector — *alternative to S-1, not additional* | ★ | ~1h | CR-2 |

#### S-1 — ToF as a real leak sensor ← **highest value hour available**

Today button C is *labelled* `leak_detected`; you press a button and assert a leak. Instead, aim the
Distance module down into a shallow tray. Pour water → surface rises → distance shrinks. That is
**level sensing**, and it maps onto real practice: industry guidance places spot leak sensors in
**CRAC/CRAH drip pans, sumps, and valve boxes** — precisely what this models.

The demo changes from *"I pressed the leak button"* to *"I poured water and the agent noticed."*
Simulating → measuring. It also consumes the sensor data you are currently discarding (CR-2).

> ⚠️ **Risk to test first:** ToF against a clear water surface can read *through* it and return weak
> or absent signal. Standard mitigation is an opaque float (ping-pong ball / foam disc) as the
> target. **Bench-test before this goes on stage**, and keep button C as the fallback trigger until
> it's proven.

#### S-2 — Rate-of-rise thermal alerting

Current thresholds (30 °C warning / 35 °C critical) are near-useless for the failure they're meant to
catch. Documented cooling-failure rise rates are **~2 °C/min, and 5 °C/min or more** when IT load
heats air unopposed; in high-density halls it's seconds. By the time a static 30 °C trips, there's no
response window left.

You already log timestamps and temperatures, so dT/dt is arithmetic on existing data — no new
hardware. It lets the agent make a **predictive** claim no thresholding system can:

> *"Temperature rising 4 °C/min, projected to cross critical in ~90 s — this is a cooling failure,
> not ambient drift."*

Demo trigger: cup hands over the Thermo. Requires CR-1 (periodic sampling) to exist at all.

#### S-3 — Dew point from T + RH

Humidity is currently used only as a raw percentage. ASHRAE expresses the recommended envelope as a
**dew-point band (−9 °C to 15 °C DP, max 60% RH)**, because condensation is the actual failure mode.
Magnus formula, ~5 lines, enables: *"27 °C at 65% RH → dew point 20 °C; 12 °C chilled water will
condense."* Cheap domain credibility.

#### S-4 — Ground thresholds in ASHRAE TC 9.9

[thresholds.ts:19-22](../mcp-tools/src/common/thresholds.ts#L19-L22) is plausible but arbitrary.
Reference values:

- **Recommended envelope: 18–27 °C** inlet, all A-classes
- **Allowable: A1 15–32 °C**, A4 5–45 °C
- **Humidity: max 60% RH recommended**; allowable max 80% RH (A1/A2) up to 90% (A4);
  recommended dew point −9 °C to 15 °C

Re-express thresholds as "outside recommended envelope" / "outside A1 allowable" and name the class
in the tool description. 15 minutes; changes how the whole project reads to anyone who knows
datacenters.

#### S-5 — Buttons as human-in-the-loop control

Once S-1 owns leak and Thermo owns thermal, the buttons are free for something better than
pretending: **A = acknowledge** (stop re-alerting, log the ack), **B = push me a full status
report**, **C = snapshot / walkthrough**. Makes the board a bidirectional control surface, shows the
agent respecting operator intent, and retires the awkward button labelled `leak_detected`.

#### S-6 — ToF as rack-door-ajar detector

Distance to a door panel; beyond X mm = ajar → cooling-loss + physical-security alert. **Competes
with S-1 for the single Distance module.** Leak is the stronger story; listed only as the fallback if
S-1's water-surface risk proves fatal.

---

## 3. How to justify the UNO Q

**The current framing is the problem.** "Bonus, not on the critical path" invites the question
*"so it's optional?"* Replace it with **three tiers, each doing only what it can**:

- **UNO Q — the sensing tier.** Physics → digital. It has no NPU and *doesn't need one*: a
  microcontroller with an I²C bus is the right tool for reading a thermometer; a 45-TOPS NPU is not.
- **X Elite — the reasoning tier.** 4B model, 64K context, tool orchestration on Hexagon.
- **S25 Ultra — the mobility tier.** The on-call engineer isn't at their desk during an incident.

Then three arguments, in this order:

1. **It is the only ground truth in the system.** Network, storage and compute are mocked. The UNO Q
   is the one input a viewer can **falsify on the spot** — pour water, breathe on the sensor, watch
   the agent react. Every other tool is a claim; this one is an experiment.
2. **It is why the offline story is real.** Board → Tailscale → laptop → local NPU. No cloud anywhere
   in the sensing-to-reasoning path, so the WiFi-off beat still answers questions about the
   *physical* world. A cloud IoT stack dies at that moment; this doesn't.
3. **It is a real DCIM discipline, not a toy.** Environmental monitoring has real standards (ASHRAE
   TC 9.9) and real economics — facilities with leak detection respond in **8–12 minutes vs 2–4
   hours** without. The board does the job a real spot sensor does, in the place a real one goes.

**The line for the stage:**

> *"We didn't put an LLM on the microcontroller — that would be a stunt. We put the LLM where the NPU
> is, and the sensor where the physics is. The UNO Q is the only part of this system you can disprove
> by pouring water on it."*

This maps directly onto the 40-point **resource utilization** criterion, which rewards each device
doing what it is best at.

---

## 4. Suggested merge into PROGRESS.md NEXT

Ordered so each step unblocks the next. Items 1–2 are small and everything else compounds on them.

1. **CR-1** — periodic `sensor_tick` from the sketch (unblocks S-1, S-2, S-3)
2. **CR-2** — surface `distanceMm` end to end
3. **CR-3 + CR-5** — fix the tool description and the `NaN` staleness hole (fast, low risk)
4. **S-1** — ToF leak sensor, *after* a bench test of the water-surface risk
5. **S-4** — ASHRAE-grounded thresholds (15 min, do it while waiting on hardware)
6. **S-2** — rate-of-rise alerting
7. **S-3** — dew point
8. **CR-4 + CR-6** — fold into the cron-alert-skill work already queued
9. **S-5** — buttons as ack/report/snapshot
10. Backlog: **CR-7**, **CR-8**, the `decideAlert` de-escalation decision

Also update [HARDWARE_UTILIZATION.md](HARDWARE_UTILIZATION.md) § *Arduino UNO Q* with §3's three-tier
framing, replacing the "bonus, not on the critical path" language.

---

## 5. Sources

- ASHRAE TC 9.9 A1–A4 limits — https://www.cky.com.tw/en/insights/ashrae-tc9-datacenter-thermal-guidelines
- ASHRAE TC 9.9 overview — https://envigilance.com/compliance/ashrae-tc-9-9/
- Modulino Thermo (HS3003) — https://docs.arduino.cc/hardware/modulino-thermo/
- Modulino Distance (VL53L4CD) — https://store-usa.arduino.cc/products/modulino-distance
- Cooling-failure temperature rise rates — https://www.datacenterknowledge.com/cooling/how-much-time-once-the-cooling-fails-
- Seconds after cooling failure (high-density) — https://www.cundall.com/ideas/blog/why-the-seconds-after-failure-matter-to-data-centre-cooling
- Leak detection sensor types / placement — https://iconprocon.com/blog_post/water-leak-detection-in-data-centers-solutions-for-critical-facilities/
- Leak detection response times — https://envigilance.com/water-leak-detection/data-center-water-leak-detection/
