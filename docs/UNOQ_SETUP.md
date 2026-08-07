# Arduino UNO Q Setup (2026-08-03)

How the UNO Q was provisioned and what it does now. Board connects to the laptop via USB-C
(for provisioning only — ADB shell, no data path) and over WiFi + Tailscale (the actual data
path). App code lives in [../uno-q/hermes-sensor-logger/](../uno-q/hermes-sensor-logger/).

## Architecture

```
UNO Q sketch (Zephyr, STM32U5)          UNO Q Linux (QCS2210, Debian 13 trixie)
  Modulino Buttons/Distance/Thermo         hermes-sensor-logger App Lab container
  on Wire1 (Qwiic bus), read every           Bridge.provide("button_pressed", ...)
  300ms to drive the LED matrix             -> appends sensor_log.jsonl (no network access
        |                                       inside the container), tick + event lines
        | Bridge.notify("button_event",            |
        |   event, distance, temp, humidity)       v
        | -- climate sensor_tick ~10s         main.py callback                    Laptop
        |    (temp + humidity only),
        |    PLUS one line per button edge
        |    (both directions: door_open/
        |    door_closed, light_on/light_off,
        |    leak_detected/leak_cleared),
        |    PLUS object_entered/object_left
        v                                            |                          (Windows,
  Arduino_RouterBridge  ------------------->  (bind-mounted file,                OpenSSH
                                               same path on host)                Server)
                                                     v                              ^
                                          push_sensor_log.sh (host, systemd) --scp--+
                                          every 10s, over Tailscale, to
                                          arduino_uno_q-sensor_log.json

  LED matrix (Arduino_LED_Matrix +
  ArduinoGraphics): always scrolling
  live temp/distance; briefly shows
  the pressed button's letter instead
```

The push interval (every 10s) and the *logging* triggers are independent — `push_sensor_log.sh`
just re-syncs whatever's in the local file on its own timer. The log grows two ways: a periodic
`sensor_tick` line roughly every 10s (this is what keeps the environmental tool on **real** data
between demos — see CR-1 in
[REVIEW_AND_SENSOR_PLAN_2026-08-03.md](REVIEW_AND_SENSOR_PLAN_2026-08-03.md)), plus one event line
per button **transition** — both press and release — and one per ToF presence crossing. Earlier
revisions of this doc said logging happened *only* on a button press; that was true before periodic
sampling landed, and is no longer. As of 2026-08-05 the tick carries **temperature and humidity
only**: distance appears on presence and button lines instead.

Two systemd units on the board's Linux side make this run unattended from boot:

- `hermes-sensor-logger.service` — `arduino-app-cli app start .../hermes-sensor-logger`
  (oneshot, `RemainAfterExit=yes`). Rebuilds and reflashes the sketch, then starts the Python
  container. Takes ~60-90s after boot since the sketch is recompiled from scratch every start.
- `hermes-sensor-logger-push.service` — runs `push_sensor_log.sh` in a `while true` loop
  (`Restart=always`). Ordered `After=` the app service and `tailscaled.service`.

Neither unit blocks hard on the other being *fully ready* (e.g. Tailscale actually connected,
not just the daemon started) — instead `push_sensor_log.sh` just keeps probing SSH and logs a
one-line failure message if `scp` fails, so a slow boot or a transient Tailscale hiccup delays
the first successful push instead of crashing anything. This was observed for real during
testing (see below).

**Local logging never depends on any of this.** `sensor_log.jsonl` is written by `main.py` on
every reading regardless of connectivity — there is no code path where a reading goes
unrecorded because the laptop is unreachable. What SSH being down changes is only the mirror:
`push_sensor_log.sh` skips the `scp` outright rather than paying its `ConnectTimeout` on a link
already known dead, and backs the SSH probe itself off to once a minute (`SSH_RETRY_EVERY`)
instead of the healthy-state 10s (`SSH_CHECK_EVERY`) — a real outage should not spend six full
auth handshakes a minute finding out it is still down. The first successful push after
reconnecting carries the whole local file, since it was never gated on connectivity to begin
with.

**Boot ordering (added 2026-08-05).** Two drop-ins on *stock* units make Tailscale wait for the
clock, because the board has no RTC battery and a VPN brought up in 1970 produces wrong timestamps
and TLS validity errors:

- `systemd-time-wait-sync.service` — **enabled** (Debian ships it disabled), `WantedBy=sysinit.target`,
  with `TimeoutStartSec=48` so a network without NTP cannot stall boot indefinitely.
- `tailscaled.service` — `Wants=` + `After=systemd-time-wait-sync.service`. `Wants=` rather than
  `Requires=`, so a failed or timed-out sync still lets the VPN start.

Total boot is **~1min 9s**, of which the clock wait is ~38s — measured, not estimated. The numbers,
how to re-measure them, and how to reboot the board gracefully (`adb reboot` does not work here)
are in
[../uno-q/hermes-sensor-logger/README.md](../uno-q/hermes-sensor-logger/README.md#boot-sequence-and-timing).

These live in `/etc/systemd/system/` on the board and are deliberately **not** in this repo — they
are host system config, not app code, so a redeploy of the app never touches them. That also means
they do **not** survive a board reflash; re-create them by hand if the board is ever rebuilt.

## Bring-up steps, in order

1. **WiFi.** The board was reachable over USB-C via `adb shell` (no App Lab GUI needed).
   NetworkManager is scriptable directly:
   ```bash
   nmcli dev wifi connect "HaQathon" password "<event-wifi-password>"
   ```
   No `sudo` required — the `arduino` user is in the `netdev` group. Connection profiles
   auto-connect on boot by default (`connection.autoconnect: yes`).

2. **Default password change.** The board ships with `arduino`/`arduino`, but the account's
   password is expired by policy — `sudo` refuses to work at all until it's changed. Over
   `adb shell` (non-interactive), only the new password is expected twice (no "current
   password" prompt, since the OS is already mid-forced-change flow):
   ```bash
   printf 'NEWPASSWORD\nNEWPASSWORD\n' | adb shell passwd
   ```

3. **Tailscale.** Installed via the standard script:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up --hostname=arduino-uno-q --ssh=false
   ```
   `tailscale up` printed a one-time browser approval URL
   (`https://login.tailscale.com/a/...`) — opened manually, signed into the same Tailscale
   account as the laptop and phone. `tailscaled.service` is enabled by
   the package install itself, so it starts on boot with no extra step, and reconnects
   automatically afterwards since the auth state persists under `/var/lib/tailscale`.

4. **Passwordless SSH to the laptop.**
   ```bash
   ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519
   ```
   Public key added to the laptop's `C:\ProgramData\ssh\administrators_authorized_keys` (the
   laptop's Windows account is an Administrator, and Windows' OpenSSH Server requires this
   specific file — not the usual `~\.ssh\authorized_keys` — for admin accounts), with ACLs
   restricted to `Administrators` + `SYSTEM` via `icacls`. SSH from the board always targets the
   laptop's Tailscale MagicDNS name (`<laptop-tailnet-host>`; environment-specific, not
   committed) — never the USB-C/ADB link, which is provisioning-only and carries no
   application traffic.

5. **Sensor identification.** The Qwiic connector (three Modulino modules chained: Buttons,
   Distance, Thermo) is wired to `Wire1`, a bus visible only from the microcontroller sketch —
   *not* the Linux side's own I2C buses (`i2cdetect` over `adb shell` on those found nothing
   relevant). Confirming this required building and flashing a small scan sketch
   (`#include <Wire.h>` + `Arduino_RouterBridge`, scanning both `Wire` and `Wire1` via
   `Monitor.print`) — this is the pre-existing `uno-q/hermes-sensor-logger`-adjacent
   `i2cscan` app already on the board. Addresses found on `Wire1`:
   - `0x29` — VL53L4CD time-of-flight distance sensor (Modulino Distance)
   - `0x3E` — Modulino Buttons
   - `0x44` — HS3003 temperature/humidity sensor (Modulino Thermo)

6. **The `hermes-sensor-logger` App Lab app.** Created via
   `arduino-app-cli app new hermes-sensor-logger`, which scaffolds both a `sketch/` (STM32/Zephyr)
   and `python/` (Linux, runs in a Docker container) side, connected by Arduino's "Bridge" RPC
   mechanism. Modeled directly on the pre-installed
   `examples:home-climate-monitoring-and-storage` example app, which already demonstrated the
   Modulino Thermo + Bridge pattern.

7. **Event-driven logging + LED matrix display (2026-08-03 follow-up).** Originally the sketch
   sampled all sensors and pushed one `Bridge.notify` every 10s regardless of button state. Changed
   to: read sensors every 300ms (for the display only), detect each button's edges, and only call
   `Bridge.notify(...)` on an actual transition. (Originally rising-edge only under the name
   `button_pressed`; since 2026-08-05 both edges are logged and the method is `button_event`.)
   The board's LED matrix
   (`Arduino_LED_Matrix` + `ArduinoGraphics`, bundled with the `arduino:zephyr` core — confirmed by
   grepping the core package for `matrixBegin`/`ArduinoGraphics` and reading the bundled
   `examples:weather-forecast` and `Arduino_LED_Matrix/examples/Basic` sketches for the real API)
   now continuously scrolls live temperature/distance, and briefly shows the pressed button's
   letter (`beginText`/`print`/`endText(NO_SCROLL)`) before resuming.

## Gotchas (in the order they were hit)

- **`sudo: a password is required` even with the correct default password** — the account's
  password was expired by policy; had to be changed via `passwd` before `sudo` would accept
  anything, expired or not.
- **`adb root` doesn't work** — `unable to connect for root: closed`. This is a production
  build; there's no way to get a root ADB shell directly. All privileged work goes through
  `sudo` with the (now-changed) account password.
- **`passwd` over a non-interactive `adb shell` pipe is prompt-order-sensitive.** Piping
  `old\nnew\nnew\n` failed with "passwords do not match" — because there was no "current
  password" prompt to consume the first line (the OS was already in forced-change mode).
  Piping just `new\nnew\n` worked.
- **`Modulino` is not the library name** — despite the pre-installed
  `home-climate-monitoring-and-storage` example's `sketch.yaml` pinning `Modulino (0.5.0)`,
  the current Arduino library index only has `Arduino_Modulino` (versions 0.6.0-0.9.0), whose
  main header is `Arduino_Modulino.h`. The include and the `sketch.yaml` entry both had to
  change from the example's `Modulino`/`Modulino.h` to `Arduino_Modulino`/`Arduino_Modulino.h`.
- **`Arduino_Modulino.h` unconditionally pulls in every sensor variant's header** —
  `vl53l4ed_class.h`, `Arduino_LTR381RGB.h`, etc. — regardless of which Modulino modules are
  actually declared/used in the sketch. `sketch.yaml` needs the *full* dependency set (HS300x,
  LPS22HB, LSM6DSOX, VL53L4CD, VL53L4ED, ArduinoGraphics, Arduino_LTR381RGB), not just the
  ones matching the physically-connected modules. `arduino-app-cli` does not resolve
  library-to-library transitive dependencies on its own — each one has to be listed explicitly.
- **`Stat /Data/Local/Tmp: No Such File Or Directory`** — both `arduino-cli lib search` and
  `arduino-app-cli app start` hardcode `/data/local/tmp` as a scratch directory (an Android-ism
  left over from the shared ADB/App-Lab tooling). It doesn't exist on this board's plain Debian
  image and had to be created once: `sudo mkdir -p /data/local/tmp && sudo chown -R
  arduino:arduino /data`.
- **The App Lab Python container has no `ssh`/`scp`.** Pushing the sensor log to the laptop
  from inside `main.py` via `subprocess` failed outright. Fixed by splitting responsibilities:
  the container only ever appends to a local file (bind-mounted, so it's visible on the host
  at the same app-relative path); a separate host-side script/systemd unit
  (`push_sensor_log.sh`) — which does have `ssh`/`scp`, since it runs directly on the board's
  Debian OS, not in the container — does the actual network push.
- **MSYS/Git-Bash path mangling on `adb push`.** Remote paths like `/home/arduino/...` were
  silently rewritten to `C:/Program Files/Git/home/arduino/...` before reaching `adb`. Fixed by
  prefixing remote-only path arguments with an extra leading slash (`//home/arduino/...`), which
  stops MSYS from rewriting that specific argument without needing to disable path conversion
  globally (which then breaks the *local* Windows-style source path in the same command).
- **Tailscale came up `offline`/"logged out" immediately after a reboot** — a boot-time DNS
  race (`failed to resolve "controlplane.tailscale.com"`) before the WiFi/DNS stack was fully
  ready. It self-healed within about a minute via Tailscale's own retry logic; the
  `push_sensor_log.sh` retry loop absorbed the gap without needing any explicit
  wait-for-Tailscale step in the systemd units.
- **`ModulinoDistance.available()` reads `false` (and `.get()` returns `-1`) until something is
  actually in range of the time-of-flight sensor** — not a bug, just no target detected yet.
  Confirmed once an object was placed near the sensor and a real `110.0`mm reading appeared in
  the log.

## ~~Known gap~~ CLOSED 2026-08-03: the MCP environmental tool now reads the pushed log

**Update:** `mcp-tools/src/environmental/file-source.ts` closes the gap described below. When
`UNOQ_SENSOR_LOG` points at the pushed JSON-lines file (wired into Hermes's `mcp_servers`
config), the environmental tool serves the newest line's temperature/humidity as
`source: "real", via: "file"`, with `leak_detected` derived from any `leak_detected` button
event within the last 5 minutes (`UNOQ_LEAK_WINDOW_S`) — so a leak alerts and then *recovers*
rather than latching forever. A staleness guard (`UNOQ_LOG_MAX_AGE_S`, default 180s) refuses old
data and falls through to the SSH-pull path (if `UNOQ_HOST` is set) and then mock, with the
failure chain recorded in `fallbackReason`. The original gap analysis is kept below for context.

## Original gap analysis (historical): this does not feed the MCP environmental tool

`mcp-tools/src/environmental/unoq-client.ts` (in [../mcp-tools](../mcp-tools)) implements a
**pull** model in the opposite direction from what's built here: the *laptop* SSHes into the
board on demand and runs a `UNOQ_SENSOR_CMD` (default `/data/local/tmp/quad/bin/read_sensors`)
that must print one line of `{"temperature_c", "humidity_pct", "leak_detected"}`. What's
described in this doc is a **push** model — the board initiates outbound SSH to the laptop
whenever a button is pressed (the `push_sensor_log.sh` 10s timer only controls how often that
file gets re-synced, not how often lines are added to it), writing a JSON-lines history file
`{"timestamp", "button", "temperature_c", "humidity_pct", "distance_mm"}` per press. There's no
`leak_detected` field at all since no leak sensor is physically wired (the hardware on hand is
Buttons/Distance/Thermo). These two mechanisms are independent and currently coexist without
conflict, but wiring real board data into the actual MCP/agent tool still requires deploying a
separate `read_sensors` script matching that pull contract — this work does not do that.

## File locations

| What | Where |
|---|---|
| Sensor JSON-lines history (laptop) | `SMH-Hermes/arduino_uno_q-sensor_log.json` |
| Sensor JSON-lines history (board, source of truth) | `/home/arduino/ArduinoApps/hermes-sensor-logger/sensor_log.jsonl` |
| App source (repo copy) | `uno-q/hermes-sensor-logger/` |
| App source (deployed on board) | `/home/arduino/ArduinoApps/hermes-sensor-logger/` |
| systemd units (deployed on board) | `/etc/systemd/system/hermes-sensor-logger.service`, `/etc/systemd/system/hermes-sensor-logger-push.service` |
