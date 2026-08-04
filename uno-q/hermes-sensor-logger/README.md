# hermes-sensor-logger

Arduino App Lab app for the UNO Q. Continuously scrolls live temperature/distance readings on the
board's LED matrix and logs sensor data to the laptop over **two channels**:

- **`sensor_tick`** — a periodic sample every 10s (temperature, humidity, ToF distance), no human
  involved. This keeps the MCP environmental tool on *real* data continuously and feeds the
  water-level leak detection (distance below `UNOQ_LEAK_DISTANCE_MM` = the float has risen).
- **Button events** — on each Modulino button press (rising edge only, not a poll), flashes that
  button's letter on the matrix and logs a named demo event (see
  [Button-to-event mapping](#button-to-event-mapping) below).

See [../README.md](../README.md) for the board bring-up (WiFi, Tailscale, SSH keys) this app
depends on, and [../../docs/UNOQ_SETUP.md](../../docs/UNOQ_SETUP.md) for the full end-to-end
writeup.

## Button-to-event mapping

| Button | Event recorded |
|---|---|
| A | `door_open` |
| B | `light_on` |
| C | `leak_detected` |

Defined in `sketch/sketch.ino`'s `BUTTON_EVENTS` array. The board's display still shows the raw
letter (A/B/C) when a button is pressed — that mapping (`BUTTON_LETTERS`) is separate and only
affects what's shown on the matrix, not what's logged.

## Files

This folder mirrors the board's app directory (`/home/arduino/ArduinoApps/hermes-sensor-logger/`)
one-for-one, so a redeploy is a straight path-for-path `adb push` with no rewriting:

```
app.yaml              sketch/sketch.ino     python/main.py
push_sensor_log.sh    sketch/sketch.yaml
```

Keep it that way — flattening `sketch/` or `python/` here breaks the push commands below.
(The two `.service` units live here for reference only; on the board they belong in
`/etc/systemd/system/`, not in the app directory.)

- `sketch/sketch.ino` — runs on the UNO Q's STM32U5 (Zephyr) side.
  - Reads the three Modulino modules over `Wire1` (the Qwiic bus — separate from the Linux side's
    internal I2C buses) every 300ms, purely to keep the on-board display live.
  - Every `loop()` iteration, scrolls the matrix (`Arduino_LED_Matrix` + `ArduinoGraphics`)
    alternating between the current temperature and distance as a short string, so each scroll
    pass stays quick.
  - Detects each button's rising edge (`isPressed()` true this tick, false last tick) and, only on
    that edge, flashes the letter (A/B/C) on the matrix for ~800ms and calls
    `Bridge.notify("button_pressed", event, distance_mm, celsius, humidity)` where `event` is the
    mapped string (`door_open`/`light_on`/`leak_detected`) — one call per physical press, not a
    periodic sample.
- `sketch/sketch.yaml` — board profile (`arduino:zephyr:unoq`) and the full library set. Only
  `Arduino_Modulino` is referenced directly for the sensors, but its transitive dependencies
  (HS300x, LPS22HB, LSM6DSOX, VL53L4CD, VL53L4ED, ArduinoGraphics, LTR381RGB) must all be listed
  explicitly here — `arduino-app-cli` does not resolve library-to-library dependencies on its own.
  `Arduino_LED_Matrix` needs no entry: it ships as part of the `arduino:zephyr` core itself.
- `python/main.py` — runs on the Linux (QCS2210) side, inside the App Lab-managed Docker
  container. Registers the `button_pressed` callback and appends one JSON line to
  `sensor_log.jsonl` per press. Deliberately does **not** talk to the network: the container has
  no `ssh`/`scp` installed, and it's simpler to keep this side dumb.
- `push_sensor_log.sh` — runs on the Linux host (outside the container). Every 10s, `scp`-overwrites
  the laptop's copy with the current local file. This 10s cadence is just the *push* interval — it
  re-sends the same (possibly unchanged) file if no button has been pressed; it has nothing to do
  with how often entries are written. Loops forever; retries silently on failure so a transient
  network drop just delays the next successful push rather than crashing anything.
- `hermes-sensor-logger.service` / `hermes-sensor-logger-push.service` — systemd units that start
  the App Lab app and the push loop on boot (see below).

## Data format

Each line in `sensor_log.jsonl` / `arduino_uno_q-sensor_log.json` is one JSON object — one per
periodic tick (every 10s) and one per button press:

```json
{"timestamp": "2026-08-03T23:53:11.983912+00:00", "event": "sensor_tick", "temperature_c": 26.01, "humidity_pct": 58.76, "distance_mm": 14.0}
{"timestamp": "2026-08-03T23:26:11.207827+00:00", "event": "leak_detected", "temperature_c": 24.18, "humidity_pct": 56.61, "distance_mm": 133.0}
```

- `event` is `sensor_tick` for the periodic channel, or one of `door_open`, `light_on`,
  `leak_detected` for a button press — see [Button-to-event mapping](#button-to-event-mapping).
- `distance_mm` is `-1.0` if the ToF sensor has no target in range (not an error).
- File is JSON Lines (one object per line), not a single JSON array — that makes both the
  in-container append and the host-side overwrite-on-push trivial and crash-safe.
- The laptop side (`mcp-tools/src/environmental/file-source.ts`) reads the newest line for
  temp/humidity/distance, treats a `leak_detected` event in the last 5 min OR a distance below the
  calibrated `UNOQ_LEAK_DISTANCE_MM` threshold as a leak, and refuses the file entirely if the
  newest line is older than `UNOQ_LOG_MAX_AGE_S` (180s in the live config — ~18 missed ticks).

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
