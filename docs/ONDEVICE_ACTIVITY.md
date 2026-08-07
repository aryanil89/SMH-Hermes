# On-device activity inference (UNO Q)

The board now runs a small local LLM to turn its own recent sensor history into
a human-readable inference — `activity-` plus a concise, consistently-named
description (≤5 words, `_`-joined) — appended to the same `sensor_log.jsonl`
it already writes. Two examples from the original ask: a rapid
temperature-rise + humidity-decline pattern reads as `activity-possible_fire_risk`;
a door-open + presence + light-on sequence reads as `activity-person_entered_room`.
Code: [`uno-q/hermes-sensor-logger/python/activity.py`](../uno-q/hermes-sensor-logger/python/activity.py),
wired into the existing Bridge callbacks in
[`python/main.py`](../uno-q/hermes-sensor-logger/python/main.py).

This doc records what was actually measured on the physical board (not
assumed), including two things that didn't work the way the request
described and had to change as a result.

## Why not QUAD

The ask was to profile/optimize this with QUAD. Two independent reasons that
didn't happen, both worth recording rather than silently substituting:

1. **QUAD wasn't reachable from this session.** `claude mcp add --transport
   http quad https://quad.infra.foundries.io/mcp` was attempted and failed
   to connect — it needs an interactive OAuth step tied to Qualcomm hackathon
   credentials that this session couldn't complete. `PROGRESS.md` records
   QUAD as registered separately on the team's Windows laptop.
2. **QUAD's own tooling doesn't reach this workload even when connected.**
   [`WORKLOAD_PLACEMENT.md`](WORKLOAD_PLACEMENT.md) already established that
   `profile_device`/`profile_workload` run on a remote x86 VM with no path to
   real device hardware. QUAD's actual value-add — NPU/QNN (Hexagon) model
   conversion and profiling — also targets different silicon than anything
   relevant here: no Hexagon NPU exists on this board's QRB2210 at all, and
   the GPU found below is a Vulkan/Mesa device, not something QNN/QAIRT
   touches.

What happened instead: the board is physically connected to the dev machine
over `adb` (`adb devices` → hostname `uno-q`), so every number in this doc was
measured directly on it — the same thing `quad-unoq`'s own SSH/ADB approach
would have done, by hand.

## Hardware: a GPU the project's docs didn't know about

[`HARDWARE_UTILIZATION.md`](HARDWARE_UTILIZATION.md) and
[`WORKLOAD_PLACEMENT.md`](WORKLOAD_PLACEMENT.md) are correct that the QRB2210
has no NPU — confirmed again here, no Hexagon/DSP node anywhere in `dmesg`.
But the board has a real, working Adreno GPU that neither doc mentions,
found by probing directly:

```
$ adb shell dmesg | grep adreno
adreno 5900000.gpu: supply vdd not found, using dummy regulator
$ adb shell vulkaninfo --summary
Turnip Adreno (TM) 702 (Mesa 25.2.6, driver: turnip, Vulkan 1.0, integrated GPU)
$ adb shell clinfo
Device Name: FD702  Device Vendor: Qualcomm  (OpenCL 3.0 via Mesa rusticl)
```

`/dev/dri/card0` + `renderD128` exist and are accessible; `mesa-vulkan-drivers`
and `mesa-opencl-icd` are installed. This is a real, currently-idle
accelerator — worth a cross-reference in the two docs above (see
[Cross-references](#cross-references-added) below), even though it turned out
not to help this specific workload (next section).

## GPU (Vulkan/Turnip) vs. CPU — measured, GPU lost

The user's initial ask, mid-implementation, was explicit: use a version that
can leverage the board's GPU. It was tried, measured, and rejected on the
evidence — recorded here rather than quietly defaulting to CPU.

**Setup**: `ggml-org/llama.cpp` release `b10298`, both the CPU-only and the
Vulkan-enabled `ubuntu-arm64` binaries, run against `SmolLM2-135M-Instruct-Q8_0.gguf`.
`llama completion --list-devices` on the Vulkan build correctly enumerates
`Vulkan0: Turnip Adreno (TM) 702 (1834 MiB, 1834 MiB free)` — the GPU path is
real and reachable.

**Result — `llama bench -p 64 -n 24 -r 3`**:

| Backend | Prefill (pp64) | Decode (tg24) | Stability |
|---|---|---|---|
| **CPU** | 45.12 ± 1.20 tok/s | **12.79 ± 1.01 tok/s** | stable |
| Vulkan (`-ngl 99`) | 3.51 tok/s (single-sample) | **0.40 tok/s** (single-sample) | **crashed** on the 3-repetition run |

The Vulkan repeated-run crash is a real driver fault, not a fluke:

```
terminate called after throwing an instance of 'vk::DeviceLostError'
  what():  vk::Device::waitForFences: ErrorDeviceLost
```

`llama bench --list-devices` reports the Adreno 702 as `matrix cores: none` —
this integrated GPU has no dedicated matmul acceleration, so LLM inference
falls back to general shader ALU work, which explains the ~32× decode gap
even before the crash. **Verdict: CPU is the shipped backend**
(`activity.py`'s `BACKEND` defaults to `"cpu"`; `ACTIVITY_LLM_BACKEND=vulkan`
exists as an override for re-testing after a driver update, not a
recommendation). This is the same "measure, don't assume" outcome
`WORKLOAD_PLACEMENT.md` reached for the laptop's GPU tier — Turnip being a
real, detected device didn't make it a faster or more stable one for this
workload.

## Model: SmolLM2-135M-Instruct, and what it can't reliably do alone

`unsloth/SmolLM2-135M-Instruct-GGUF`, Q8_0 (~145 MB) — the exact model class
`HARDWARE_UTILIZATION.md` already cites as Arduino-vetted for this board.
Fetched (not committed) by
[`scripts/fetch_llm_runtime.sh`](../uno-q/hermes-sensor-logger/scripts/fetch_llm_runtime.sh),
same pattern as the `face-cpu` ONNX models.

**Blind classification from raw sensor prose does not work reliably at this
scale.** Across many on-device runs (135M and a 360M variant, several
temperatures, several few-shot orderings), asking the model to pick one of 7
labels from a description of recent events produced answers with no reliable
correlation to the actual input — e.g. the fire-risk pattern (temperature
rising, humidity falling) was labeled `person_entered_room` or
`person_left_room` depending on the run. Root-caused two real, fixable
contributors along the way (both now fixed in `activity.py`, in case they
recur with a different model):

- **A 2:1 few-shot label imbalance** (two `person_*` examples, one
  `possible_fire_risk` example) biased the model toward the majority label
  regardless of content — fixed by balancing to one example per category.
- **`--log-disable` combined with `--no-display-prompt`** silences the
  generated completion text on stdout entirely, not just the logging —
  `--no-display-prompt` alone is what actually gives clean stdout (verified
  directly; logging still goes to stderr).

Neither fix solved the underlying accuracy ceiling. At low temperature the
model would sometimes emit the *system prompt itself* verbatim instead of a
label (`"You are a sensor-fusion assistant for a single room..."`) rather than
following the "output only the label" instruction — a real instruction-following
gap at 135M scale for this kind of structured multi-example prompt, not
something further prompt tweaking resolved in the time available.

**What actually ships**: the deterministic Python prefilter in `activity.py`
already knows *why* it's calling the model — it computed the trigger (a
specific rate-of-change crossing, or a specific door/light/presence
combination) — so it hands the model a `Suggested: <label>` hint alongside
the event summary and asks it to confirm-or-improve, rather than classify
from nothing. `_resolve_activity()` then applies a hard safety net: if the
model's cleaned-up output lands on a real vocabulary word (confirming the
hint, or genuinely overriding it to a *different* valid canonical label),
that's trusted; otherwise the deterministic hint is used directly rather than
whatever the model produced. Measured on-device (`python/test_activity.py`'s
`test_live_scenarios`): the raw model missed its hint in essentially every
sampled run during this test pass, and the resolved output was correct in
100% of them via the fallback. The model is still genuinely in the loop — it
does the vocabulary/format enforcement and the true "invent a new label"
path for patterns with no deterministic hint (`_candidate_from_transition`
returns `None` for `door_closed`/`light_on`/`light_off` alone, on purpose,
rather than guessing) — but a fire-risk-class label is never allowed to
depend solely on this model size getting a free-text judgment call right.

## Latency and footprint (measured, CPU backend, cold subprocess each call)

| Metric | Value |
|---|---|
| Model file | 139 MB (`Q8_0`) |
| CPU runtime (llama.cpp `b10298`, `ubuntu-arm64`) | 31 MB |
| Vulkan runtime (unused in production) | 72 MB |
| Prefill | 45.12 ± 1.20 tok/s (`llama bench -p 64`) |
| Decode | 12.79 ± 1.01 tok/s (`llama bench -n 24`) |
| End-to-end latency per inference call, Python `subprocess.run` (3 samples) | 7.16s / 7.40s / 7.49s |

The 7+s figure is a fresh-process cost (no persistent server — each call
loads the model from scratch), which is exactly why `activity.py` gates calls
behind a deterministic prefilter (door/light/presence transitions, or a
sustained rate-of-change crossing) instead of running on every ~10s
`sensor_tick`, and runs the call on a background thread so it never blocks
the Bridge RPC thread that logs the underlying sensor reading.
`INFER_TIMEOUT_S = 12.0` gives headroom over the measured worst case; a
timeout is treated as a failed call (falls back to the deterministic hint,
same as any other model failure).

## Log schema

One new JSON-lines event type, same file, additive:

```json
{"timestamp": "...", "event": "activity", "activity": "activity-person_entered_room", "trigger": "object_entered, door_open, light_on", "temperature_c": 22.4, "humidity_pct": 45.1}
```

Verified safe for existing consumers by reading, not assuming:
`mcp-tools/src/environmental/file-source.ts`'s `parseSensorLogLine` only
requires `timestamp`/`event`(string)/`temperature_c`/`humidity_pct`, all
present here. Its leak-detection scan tests `event.includes("leak")` against
the **event field**, which is always the fixed literal `"activity"` here (the
real label lives in the separate `activity` field) — an activity string can
never accidentally trip `leak_detected`. `leak_detected`/`leak_cleared`
themselves are deliberately excluded from LLM inference in `main.py` — that
channel already has a real, trusted detector; routing it through this model
would only add latency and a new failure mode to a path that's supposed to be
boring. `mcp-tools/src/dashboard/snapshot.ts`'s `DEVICE_EVENT_LABELS` lookup
falls through unmapped events (`// sensor_tick and anything unrecognised:
counted, not streamed`), so an `"activity"` line was inert on the wall when
this first shipped. **Since wired (2026-08-06):** the wall now streams
activity lines with a human-readable label and status
(`dashboard/snapshot.ts` + `common/activity.ts`), and the watchdog folds a
fresh activity line into the Telegram alert text (`alert-skill/tick.ts`).
`npm test` in `mcp-tools/` (327/327 then, 333/333 with the activity tests)
confirmed no regression.

**And since 2026-08-07, the agent itself.** Until then the consumer list was
the wall and the watchdog — both *push* surfaces. Ask the agent a question and
it knew only the temperature, so the wall could be showing "person entered
room" while the agent, asked about that same moment, could not mention it.
`getEnvironmentalReading` now carries the newest inference on the reading
(`environmental/source.ts`, field `activity`, real file path only) and
`get_incident_assessment` reports it as `observedActivity` plus one sentence
in `summary`.

Three properties that are load-bearing, not incidental:

1. **It is never scored.** The sentence is built *after* `scoreRisk` and
   `assessConfidence` have already run over `evidence`, and it never touches
   that array — so it is structurally incapable of moving the risk number,
   pulling `physical` into `familiesInvolved`, or shifting the correlation
   bonus. Risk stays a reproducible function of measurements; a 1.5B model's
   guess about a room is not a measurement. A test asserts the whole verdict
   is bit-for-bit identical with and without an activity present.
2. **It says so out loud.** The summary reads `Also observed (not scored):
   ...`, placed after the measured evidence. The agent is instructed to relay
   `summary` verbatim, so a disclaimer anywhere else would be one the on-call
   never hears.
3. **It is not staleness-gated, and carries its age.** A sensor line older
   than `UNOQ_LOG_MAX_AGE_S` is untrustworthy because it samples a value that
   has since moved; an activity line is an *event*, and "someone entered the
   room four minutes ago" is still the last thing the board concluded.
   Suppressing it would tell the agent nothing had happened. The age travels
   with it, phrased for a person ("30 minutes ago", not "1731s").

## Testing

- `python3 uno-q/hermes-sensor-logger/python/test_activity.py` — pure-Python
  checks (normalization, prefilter state tracking, rate-of-change math,
  cooldown, the hint-fallback resolver) plus `test_live_scenarios`, which
  shells out to the real model on the real board and is skipped automatically
  if `runtime/` hasn't been fetched.
- **Live hardware walkthrough** (needs a human at the board for the physical
  actions — buttons, hand near the Distance sensor, warming the Thermo
  module):
  1. Press button **A** (door), hold a hand within ~1000mm of the Distance
     sensor, press button **B** (light) → expect `activity-person_entered_room`
     within a few seconds.
  2. Move the hand away (`object_left`), press button **A** again
     (`door_closed`) → expect `activity-person_left_room`.
  3. Warm the Thermo module (breath/hand, not a real heat source) for
     30–60s → expect `activity-possible_fire_risk` once the rate crosses
     `TEMP_RISE_C_PER_MIN`/`HUMIDITY_FALL_PCT_PER_MIN`.
  4. Wait ≥`COOLDOWN_SECONDS` (120s default) between repeats of the same
     scenario to see it fire again rather than being suppressed.
  Tail `sensor_log.jsonl` on the board (`adb shell tail -f
  /home/arduino/ArduinoApps/hermes-sensor-logger/sensor_log.jsonl`) while
  running these.

  **Run and verified live, 2026-08-06** (all three scenarios, on the actual
  board, by a human doing the physical actions above): `door_open` →
  `object_entered` → `activity-person_entered_room` in 9s; `object_left` →
  `activity-person_left_room` in 7s; a sustained warm-breath ramp from
  24°C → 40°C produced `activity-possible_fire_risk` at the first threshold
  crossing (~30°C) and correctly fired again later in the same ramp once the
  cooldown expired, rather than going silent after one alert. A `door_open`
  with no presence/light following it correctly produced
  `activity-door_left_open` instead of a person-entered guess, and
  `door_closed` alone correctly produced no activity line at all (no
  confident deterministic hint for that case — see
  `_candidate_from_transition`). Base `sensor_tick` logging continued on its
  normal ~10s cadence throughout, uninterrupted. Full log excerpt kept in the
  session transcript, not reproduced here.

## Cross-references added

One-line pointers added to keep the "what's actually running where" picture
accurate, without rewriting either doc's existing NPU conclusions (which
remain correct):

- `docs/HARDWARE_UTILIZATION.md` — Adreno 702 / Turnip exists on the UNO Q,
  detailed here.
- `docs/WORKLOAD_PLACEMENT.md` — the GPU tier now has a measured (rejected)
  candidate on the UNO Q, detailed here.
