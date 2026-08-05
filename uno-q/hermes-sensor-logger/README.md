# hermes-sensor-logger

Arduino App Lab app for the UNO Q. Continuously scrolls live temperature/distance readings on the
board's LED matrix and logs sensor data to the laptop over **three channels**:

- **`sensor_tick`** — a periodic climate sample every 10s (**temperature and humidity only**), no
  human involved. This keeps the MCP environmental tool on *real* data continuously rather than
  tripping its staleness guard.
- **Button events** — on every Modulino button *transition*, both edges, flashes that button's
  letter on the matrix and logs a named demo event (see
  [Button-to-event mapping](#button-to-event-mapping) below).
- **Presence events** — `object_entered` / `object_left` when the ToF distance crosses
  `PRESENCE_THRESHOLD_MM` (see [Presence detection](#presence-detection)). This is the only channel
  that carries a distance measurement.

See [../README.md](../README.md) for the board bring-up (WiFi, Tailscale, SSH keys) this app
depends on, and [../../docs/UNOQ_SETUP.md](../../docs/UNOQ_SETUP.md) for the full end-to-end
writeup.

## Button-to-event mapping

The buttons model a **state**, not a momentary trigger: both edges are logged, so the log can be
replayed to know what the state was at any point.

| Button | Pressed | Released |
|---|---|---|
| A | `door_open` | `door_closed` |
| B | `light_on` | `light_off` |
| C | `leak_detected` | `leak_cleared` |

Defined in `sketch/sketch.ino`'s `BUTTON_EVENTS_PRESSED` / `BUTTON_EVENTS_RELEASED` arrays. The
board's display still shows the raw letter (A/B/C) — that mapping (`BUTTON_LETTERS`) is separate and
only affects the matrix, not the log. Only the *press* flashes the letter: flashing again on release
would read as a second press, and its 800ms block would delay the next button scan.

⚠️ **`leak_cleared` contains the substring `leak`.** The laptop's event-leak test scans the log
newest-first and originally used `event.includes("leak")`, so the very event that clears a leak
re-raised it and latched the alert on for the whole `UNOQ_LEAK_WINDOW_S`. `file-source.ts` now
checks for `leak_cleared` *before* the substring test and stops the scan there. Keep that ordering
if you touch it, and avoid naming any future event `*leak*` unless it really means "a leak is
happening".

## Files

This folder mirrors the board's app directory (`/home/arduino/ArduinoApps/hermes-sensor-logger/`)
one-for-one, so a redeploy is a straight path-for-path `adb push` with no rewriting:

```
app.yaml              sketch/sketch.ino     python/main.py
push_sensor_log.sh    sketch/sketch.yaml    python/show_boot_stages.py
```

(`sensor_log.jsonl` and `boot_status.json` are generated on the board at runtime, not kept here.)

Keep it that way — flattening `sketch/` or `python/` here breaks the push commands below.
(The two `.service` units live here for reference only; on the board they belong in
`/etc/systemd/system/`, not in the app directory.)

- `sketch/sketch.ino` — runs on the UNO Q's STM32U5 (Zephyr) side.
  - Reads the three Modulino modules over `Wire1` (the Qwiic bus — separate from the Linux side's
    internal I2C buses) every 300ms, purely to keep the on-board display live.
  - Every `loop()` iteration, scrolls the matrix (`Arduino_LED_Matrix` + `ArduinoGraphics`)
    alternating between the current temperature and distance as a short string, so each scroll
    pass stays quick.
  - Detects each button's edges (`isPressed()` differing from last tick) and, on **either**
    direction, calls `Bridge.notify("button_event", event, distance_mm, celsius, humidity)` where
    `event` is the mapped string for that direction — one call per transition, not a periodic
    sample. A press also flashes the letter (A/B/C) on the matrix for ~800ms; a release does not.
  - Provides `set_stage(stage, ok, text)` over the Bridge so the Linux side can drive the
    boot/connection display (see [Boot and connection display](#boot-and-connection-display)).
  - Gates the logged distance at `PRESENCE_THRESHOLD_MM` and emits `object_entered` /
    `object_left` on crossings (see [Presence detection](#presence-detection)).
- `python/show_boot_stages.py` — dev tool, not part of the app. Cycles the matrix through every
  stage so the icons can be checked by eye without power-cycling the board.
- `sketch/sketch.yaml` — board profile (`arduino:zephyr:unoq`) and the full library set. Only
  `Arduino_Modulino` is referenced directly for the sensors, but its transitive dependencies
  (HS300x, LPS22HB, LSM6DSOX, VL53L4CD, VL53L4ED, ArduinoGraphics, LTR381RGB) must all be listed
  explicitly here — `arduino-app-cli` does not resolve library-to-library dependencies on its own.
  `Arduino_LED_Matrix` needs no entry: it ships as part of the `arduino:zephyr` core itself.
- `python/main.py` — runs on the Linux (QCS2210) side, inside the App Lab-managed Docker
  container. Registers the `button_event`, `sensor_tick` and `presence_event` callbacks and appends
  one JSON line to `sensor_log.jsonl` each time one fires; `_log_reading()` omits `distance_mm`
  entirely for the climate channel. Deliberately does **not** talk to the network: the container has
  no `ssh`/`scp` installed, and it's simpler to keep this side dumb. Also runs the boot-display
  thread that reads `boot_status.json` and drives the sketch through its stages.
- `push_sensor_log.sh` — runs on the Linux host (outside the container), on a 1s tick:
  - **Every tick**, writes `boot_status.json` (WiFi / clock / SSH state) for the boot display. The
    probing lives here because `nmcli`, `timedatectl` and `ssh` exist only on the host — the
    container has none of them.
  - **Every 10th tick**, `scp`-overwrites the laptop's copy with the current local file. That 10s
    cadence is just the *push* interval — it re-sends the same (possibly unchanged) file if no
    button has been pressed; it has nothing to do with how often entries are written.

  Loops forever; retries silently on failure so a transient network drop just delays the next
  successful push rather than crashing anything.
- `hermes-sensor-logger.service` / `hermes-sensor-logger-push.service` — systemd units that start
  the App Lab app and the push loop on boot (see below).

## Data format

Each line in `sensor_log.jsonl` / `arduino_uno_q-sensor_log.json` is one JSON object — one per
periodic tick (every 10s), one per button transition, and one per presence crossing:

```json
{"timestamp": "2026-08-05T00:36:00.154124+00:00", "event": "sensor_tick", "temperature_c": 24.67, "humidity_pct": 57.51}
{"timestamp": "2026-08-05T00:27:47.104254+00:00", "event": "object_left", "temperature_c": 24.84, "humidity_pct": 57.35, "distance_mm": -1.0}
{"timestamp": "2026-08-03T23:26:11.207827+00:00", "event": "leak_detected", "temperature_c": 24.18, "humidity_pct": 56.61, "distance_mm": 133.0}
```

- `event` is one of:
  - `sensor_tick` — the periodic 10s climate channel.
  - `door_open`/`door_closed`, `light_on`/`light_off`, `leak_detected`/`leak_cleared` — a button
    transition, see [Button-to-event mapping](#button-to-event-mapping).
  - `object_entered` / `object_left` — a ToF presence crossing, see
    [Presence detection](#presence-detection).
- **`distance_mm` is absent entirely on `sensor_tick` lines** — the climate channel carries no
  distance. Only button and presence events include the field.
- Where present, `distance_mm` is `-1.0` whenever there is no usable reading — nothing within
  `PRESENCE_THRESHOLD_MM`, no target in range at all, or the Distance module not responding. It is
  never a measurement, and the laptop side already guards `distance_mm >= 0` before reporting it or
  testing it against the leak threshold ([file-source.ts:155](../../mcp-tools/src/environmental/file-source.ts#L155)),
  so a `-1.0` can never be mistaken for a very close object.
- File is JSON Lines (one object per line), not a single JSON array — that makes both the
  in-container append and the host-side overwrite-on-push trivial and crash-safe.
- The laptop side (`mcp-tools/src/environmental/file-source.ts`) reads the newest line for
  temp/humidity/distance, treats a `leak_detected` event in the last 5 min (not since cancelled by a
  `leak_cleared`) OR a distance below the calibrated `UNOQ_LEAK_DISTANCE_MM` threshold as a leak,
  and refuses the file entirely if the newest line is older than `UNOQ_LOG_MAX_AGE_S` (180s in the
  live config — ~18 missed ticks).

⚠️ **Level-based leak detection is effectively unreachable now that `sensor_tick` carries no
distance.** The laptop reads *the newest line* for distance, and the newest line is almost always a
tick — which no longer has the field. A distance now only reaches the reader in the moment a
presence or button event is logged, so `UNOQ_LEAK_DISTANCE_MM` would only ever fire on that exact
line. Event-based leak detection (button C) is unaffected and remains the live path. If the
water-level rig is wanted back, the fix is to put `distance_mm` back on the tick — that is the
channel the level design depends on.

## Presence detection

The ToF module doubles as a presence sensor. A distance is only recorded while something is nearer
than `PRESENCE_THRESHOLD_MM` (**1000mm**); at or beyond that, `distance_mm` is written as `-1.0`.
The board shows the same gated value, so `D:--` on the matrix and `-1.0` in the log always agree.

Only the *crossings* are logged, the same rising-edge idea the buttons use — an object parked in
front of the sensor produces one line on arrival and one on departure, not a line per tick:

| Event | Meaning |
|---|---|
| `object_entered` | Distance dropped below 1000mm |
| `object_left` | Distance rose back to 1000mm or beyond (or the target was lost) |

Two details in `sketch/sketch.ino` worth keeping:

- **Debounce, not hysteresis.** An object sitting right at the boundary makes readings flicker
  either side of it, which would emit an entered/left pair every few hundred ms.
  `PRESENCE_DEBOUNCE_READS` (3, so ~900ms) requires the new state to hold before it is believed.
  The threshold itself is *not* widened — 1000mm means 1000mm in both directions.
- **`sensor_tick` keeps flowing regardless.** Only the distance *value* is gated, never the tick
  itself. Suppressing ticks when nothing is in range would starve the laptop's staleness guard
  (`UNOQ_LOG_MAX_AGE_S`) and drop the environmental tool to mock whenever the sensor saw nothing.

⚠️ **`UNOQ_LEAK_DISTANCE_MM` must be below 1000mm** now, or level-based leak detection can never
fire: anything at or beyond the presence threshold reaches the laptop as `-1.0`, which the leak
test rejects as "no sample". A drip-tray float sits well inside 1000mm, so this is only a trap if
someone calibrates the threshold against a target further away than the presence gate.

### If distance is always `-1.0`

`distance.begin()` returns a bool and the sketch now checks it — a Distance module that does not
answer on the Qwiic bus used to fail *silently*, leaving the logged distance at `-1.0` forever,
which looks exactly like "nothing in range". The sketch now recovers by itself from both failure
modes, retrying `begin()` every `DISTANCE_RETRY_INTERVAL` (5s) and treating
`DISTANCE_STALL_TIMEOUT` (10s) with no sample as the module having gone away. Reseating the Qwiic
connector therefore brings it back with no reflash and no restart.

If it stays `-1.0` while temperature and humidity keep updating, the Thermo module is answering and
the Distance one is not — that is a cable or module fault, not a software one.

## Boot and connection display

Taking the board to a new location means the whole chain (WiFi → NTP → Tailscale/SSH) can fail
with no laptop attached to say why. The matrix therefore walks through the sequence as it happens,
so a failure is visible on the board itself:

| Stage | Code | Shown |
|---|---|---|
| System booted | 0 | A boot (the footwear). Drawn in `setup()` before anything that can block, so it appears the moment the MCU is alive. |
| WiFi | 1 | WiFi arcs + a **check mark** when associated, or WiFi arcs + a **frowning face** while not. |
| System time | 2 | The clock scrolling as `HH:MM`, once NTP has actually set it. |
| SSH | 3 | The label `SSH` alternating (~700ms) with a **check** or a **frown**. "SSH" is 12px wide in `Font_4x6` and fills the 13px canvas on its own, so the label and its verdict take turns rather than sharing the row. |
| Running | 4 | The live sensor readout — the original scrolling temperature/distance. |

**How it's wired.** `push_sensor_log.sh` (host) writes `boot_status.json` every second → `main.py`
(container) reads it through the bind-mounted app directory → `Bridge.call("set_stage", stage, ok,
text)` → the sketch renders. The Linux side owns *deciding*, the sketch owns *drawing*.

Three things worth knowing before changing any of this:

- **The RPC handler must never draw.** `Bridge.begin()` spawns its own Zephyr thread to service
  incoming calls, so `set_stage()` runs concurrently with `loop()`. It only records state
  (`g_stage`, `g_stageOk`, `g_stageText`) and every render happens in `loop()` — drawing from both
  threads would race on the matrix. `g_stage` is assigned *last* so the text and flag are in place
  before `loop()` acts on the new stage.
- **Logging is independent of the display.** `sensor_tick` and button events sit outside the stage
  machine, so data keeps flowing whatever the matrix shows, including mid-boot-sequence.
- **Each stage has a floor and a ceiling.** `MIN_DWELL_S` (3s) keeps a fast connect from blinking
  past unread; `STAGE_TIMEOUT_S` (60s) stops a dead link — no NTP behind a captive portal, laptop
  asleep — from stranding the display short of the sensor readout. A stage that times out has been
  showing its frown the whole time, then the sequence moves on.

⚠️ **The SSH probe must be `ssh … "exit 0"`, not `ssh … true`.** The laptop's SSH shell is
PowerShell, where `true` is not a command: the probe fails with `CommandNotFoundException` and the
display reports a frown even though the link is perfectly healthy. This bit us once already.

To check the icons without power-cycling the board (safe at any time — sensor logging is
unaffected and it ends back on the live readout):

```bash
adb shell 'docker exec hermes-sensor-logger-main-1 python3 /app/python/show_boot_stages.py 4'
```

## Display behavior and its tradeoff

The matrix is only 13x8 pixels — with `Font_5x7`, roughly 2 characters are legible without
scrolling, so multi-digit values (temperature, distance in mm) need `endText(SCROLL_LEFT)`, which
blocks for the whole scroll pass. Buttons are only checked *between* passes (once each loop()
iteration), so worst-case press-to-log latency is about one scroll pass (roughly 1-2s at the
current speed/string-length settings), not truly instantaneous. Pressing multiple buttons in quick
succession while a scroll pass or the 800ms letter-flash is in progress can miss a very brief tap
if it starts and ends entirely within that window — confirmed in testing that normal presses
(even three in a row, a couple seconds apart) are all caught. Passes alternate between temperature
and distance and are kept short specifically to bound this latency — if tighter responsiveness is
needed later, it would require a custom frame-by-frame scroll implementation instead of the
high-level `endText()` call, which doesn't yield control mid-scroll.

## How this feeds the MCP environmental tool (gap closed 2026-08-03)

The MCP tool (`mcp-tools/src/environmental/source.ts`) reads sources in order: (1) this app's
pushed/pulled log file (`UNOQ_SENSOR_LOG`), (2) an on-demand SSH pull (`UNOQ_HOST`,
`unoq-client.ts` — still unimplemented board-side, now redundant), (3) mock fallback with an
explicit reason. With the 10s `sensor_tick` channel, source (1) keeps the tool on real data
continuously.

**Leak detection is now two-signal:**

- **Level (real measurement)** — the Distance Modulino faces down over a drip tray with an opaque
  float; water in the tray lifts the float, the ToF distance shrinks, and a reading below
  `UNOQ_LEAK_DISTANCE_MM` reports `leakDetected: true, leakVia: "level"`. Recovers by itself when
  the level drops.
- **Event (demo fallback)** — button C logs a `leak_detected` event; a leak event within the last
  `UNOQ_LEAK_WINDOW_S` (default 300s) reports `leakVia: "event"`. This is a person pressing a
  button, kept as the stage fallback if the water rig misbehaves.

## Transport: Tailscale push vs USB pull

Primary: `push_sensor_log.sh` on the board scp-pushes over Tailscale every 10s. **Fallback (no
WiFi/tailnet — bench work, demo table):** run `../pull_sensor_log.ps1` on the laptop instead; it
adb-pulls the same file over the USB cable at the same cadence. Same laptop path, so nothing else
changes.

## ⚠️ Board clock gotcha (bites every off-network power cycle)

The UNO Q has **no RTC battery** — it boots thinking it's 1970 and only gets real time from NTP,
which needs WiFi. With a wrong clock, every log timestamp is wrong and the laptop's staleness
guard (`UNOQ_LOG_MAX_AGE_S`) will — correctly — refuse the data as stale and fall back to mock.
`sudo` over `adb shell` wants a password, but the `arduino` user is in the `docker` group and the
image entrypoint runs as a non-root container user, so set the kernel clock like this (one line,
from the laptop, fill in current UTC):

```powershell
$utc = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ss")
adb shell "docker run --rm --user 0 --cap-add SYS_TIME --entrypoint date ghcr.io/arduino/app-bricks/python-apps-base:0.5.0 -u -s '$utc'"
```

Do this after every board power-up when it isn't on a network with NTP — and at the venue,
re-auth Tailscale (`tailscale status` on the board currently says logged out).

## Rebuilding / redeploying

Run from this directory (`uno-q/hermes-sensor-logger/`), with the board on USB:

```bash
adb push sketch/sketch.yaml sketch/sketch.ino /home/arduino/ArduinoApps/hermes-sensor-logger/sketch/
adb push python/main.py /home/arduino/ArduinoApps/hermes-sensor-logger/python/main.py
adb shell arduino-app-cli app restart /home/arduino/ArduinoApps/hermes-sensor-logger
```

`adb devices -l` should list the board as `2397021105 … device` first; `unauthorized` or an empty
list means the cable or the USB-C port, not the app. A sketch change triggers a recompile on the
board, so the restart takes ~1 min; a `python/main.py`-only change restarts in seconds.

(**On Windows/Git Bash only**, prefix the remote paths with an extra `/` — e.g.
`//home/arduino/...` — to stop MSYS from rewriting them into a Windows path. On macOS/Linux use
the single-slash paths above as written.)
