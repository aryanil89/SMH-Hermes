# uno-q

Deployment config for the Arduino UNO Q, driven via QUAD's `quad-unoq` skill (SSH/ADB plumbing —
see `QUAD-Client-main/.claude/skills/quad-unoq/`).

Status: **bonus, not on the critical path**. The board (Qualcomm QRB2210 "Dragonwing" + STM32U585
MCU) doesn't host the agent's LLM — by choice, not because it can't run one. **It has no NPU**
(Qualcomm: AI models run on the GPU and CPU), no official TOPS figure exists for it, it ships in
2GB and 4GB variants, and Arduino officially demos SmolLM2-135M and Llama-3.2-1B-Q4 on it. There's
simply no headroom for a 4B tool-calling model, and no accelerator to help — so the laptop keeps the
brain and this board does what it's actually good at: sensing. (An earlier version of this line
claimed "1 TOPS, 2GB RAM, INT8-only" — wrong on all three counts, traced to QUAD's `quad-unoq`
reference table; see [../docs/AUDIT_2026-08-03.md](../docs/AUDIT_2026-08-03.md) §1.5.)

Backs the **environmental/physical-monitoring** MCP tool in [../mcp-tools](../mcp-tools) with real
temperature/humidity/distance data. The Modulino modules on hand are **Buttons, Distance, and
Thermo** — there is no dedicated leak-sensing hardware, so **button C is the working leak trigger**
(`leak_detected` on press, `leak_cleared` on release).

The board logs over **three channels**: a `sensor_tick` every 10s carrying **temperature and
humidity only**, one line per **button transition** (both edges), and `object_entered` /
`object_left` when the ToF distance crosses 1000mm. See
[hermes-sensor-logger/README.md](hermes-sensor-logger/README.md) for the full data format.

⚠️ The **water-level leak design** (Distance module over a drip tray with a float, tripping
`UNOQ_LEAK_DISTANCE_MM`) is documented across `../docs/` but is **not currently reachable**: since
`sensor_tick` no longer carries a distance, and the laptop reads the newest line, a distance only
arrives on presence/button events. Button C is the live leak path. Restoring the level design means
putting `distance_mm` back on the tick.

## What's implemented

Board bring-up (WiFi with [roaming across five networks](#board-bring-up-summary), Tailscale VPN,
passwordless SSH to the laptop) plus a `hermes-sensor-logger` App Lab app that:

- steps the LED matrix through a **boot/connection display** (booted → WiFi → clock → SSH → live
  readout) so a failure at a new location is visible on the board itself;
- shows live temperature/distance on the matrix once running;
- streams JSON log lines to the laptop on every button transition and presence crossing, plus a
  10s climate tick — event-driven, not a fixed poll interval.

Full writeup: [../docs/UNOQ_SETUP.md](../docs/UNOQ_SETUP.md). App code:
[hermes-sensor-logger/](hermes-sensor-logger/).

### Board bring-up summary

1. **WiFi**: `nmcli dev wifi connect "HaQathon" password "..."` from a Linux shell reached over
   ADB (`adb shell` — no App Lab GUI needed). Profile auto-connects on boot by default.

   **Roaming (added 2026-08-04):** the board carries five saved profiles so it comes up on its own
   at other locations. NetworkManager activates the highest-priority profile whose SSID is in
   range, so the venue network still wins wherever it exists, and the phone hotspot is last so it
   only burns cellular data when nothing else is available:

   | Priority | SSID | Security |
   |---|---|---|
   | 100 | `HaQathon` (venue) | WPA3 (`sae`) |
   | 50 | `<home-network-1>` | WPA2 (`wpa-psk`) |
   | 40 | `<home-network-2>` | WPA2 (`wpa-psk`) |
   | 30 | `<home-network-3>` | WPA2 (`wpa-psk`) |
   | 10 | `<phone-hotspot>` | WPA2 (`wpa-psk`) |

   Passwords are stored only in the board's NetworkManager keystore
   (`/etc/NetworkManager/system-connections/`, root-readable) — deliberately **not** in this repo.
   To add another network or change a priority:

   ```bash
   adb shell 'nmcli con add type wifi con-name "SSID" ifname wlan0 ssid "SSID" -- \
     wifi-sec.key-mgmt wpa-psk wifi-sec.psk "PASSWORD" \
     connection.autoconnect yes connection.autoconnect-priority 20'
   adb shell 'nmcli con mod "SSID" connection.autoconnect-priority 60'   # reorder
   adb shell 'nmcli -f AUTOCONNECT-PRIORITY,NAME,ACTIVE con show'        # review
   ```

   Notes: a WPA-PSK passphrase must be **8–63 characters** — `nmcli` rejects anything shorter. Use
   `wifi-sec.key-mgmt sae` instead of `wpa-psk` for a WPA3-only network (`wpa-psk` already covers
   WPA2 and WPA2/WPA3-transition APs). If an SSID contains an apostrophe or other shell
   metacharacter, put the `nmcli` call in a script and `adb push` it rather than fighting nested
   quoting. Roaming does **not** remove the clock caveat below — a network without working NTP
   still leaves the board with a wrong date.
2. **Tailscale**: installed via the standard `curl -fsSL https://tailscale.com/install.sh | sh`,
   authenticated once via browser against the same tailnet as the laptop and phone
   (`galaxy-s25-ultra`), `tailscaled.service` enabled at boot. Board
   shows up as `arduino-uno-q` on the tailnet.
3. **SSH key auth to the laptop**: `arduino` user's ed25519 key added to the laptop's
   `C:\ProgramData\ssh\administrators_authorized_keys` (Windows requires this special file, not
   `~\.ssh\authorized_keys`, for accounts in the Administrators group). SSH only ever targets the
   laptop's Tailscale MagicDNS hostname (environment-specific, set in `push_sensor_log.sh`) —
   never the USB-C/ADB link, which is provisioning-only.
4. **Default password change**: the board ships with `arduino`/`arduino`, expired by policy on
   first use — had to be changed (non-interactively, via `passwd` over `adb shell`) before `sudo`
   would work at all.

### Gotchas hit during bring-up (see docs/UNOQ_SETUP.md for full detail)

- Sensor library is `Arduino_Modulino`, not `Modulino` — despite older shipped examples pinning
  `Modulino (0.5.0)` in `sketch.yaml`.
- `Arduino_Modulino.h` pulls in every sensor variant unconditionally, so all of HS300x, LPS22HB,
  LSM6DSOX, VL53L4CD, VL53L4ED, ArduinoGraphics, and Arduino_LTR381RGB must be listed in
  `sketch.yaml`, not just the ones actually wired up.
- Several `arduino-app-cli`/`arduino-cli` operations hardcode `/data/local/tmp` (an Android-ism);
  it doesn't exist on this board's Debian image by default and has to be created once.
- The Modulino sensors are on `Wire1` (the Qwiic connector), a bus visible only from the
  microcontroller sketch side — the Linux side's own I2C buses (`i2cdetect` from `adb shell`) show
  nothing relevant.
