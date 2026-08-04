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
Thermo** — there is no dedicated leak-sensing hardware, so leak detection is done with the
**Distance (ToF) module as a water-level sensor**: pointed down over a drip tray with an opaque
float, water lifts the float and the distance reading drops below a calibrated threshold
(`UNOQ_LEAK_DISTANCE_MM`). Button C remains a manual leak-event trigger as the demo fallback. The
board emits a `sensor_tick` log line every 10s (plus one line per button press), so the MCP tool
runs on continuously fresh real data — see
[hermes-sensor-logger/README.md](hermes-sensor-logger/README.md#how-this-feeds-the-mcp-environmental-tool-gap-closed-2026-08-03).

## What's implemented

Board bring-up (WiFi, Tailscale VPN, passwordless SSH to the laptop) plus a `hermes-sensor-logger`
App Lab app that continuously shows live temperature/distance on the board's LED matrix and, on
each Modulino button press, flashes that letter on the matrix and streams one JSON log line to the
laptop — event-driven, not a fixed poll interval. Full writeup:
[../docs/UNOQ_SETUP.md](../docs/UNOQ_SETUP.md). App code: [hermes-sensor-logger/](hermes-sensor-logger/).

### Board bring-up summary

1. **WiFi**: `nmcli dev wifi connect "HaQathon" password "..."` from a Linux shell reached over
   ADB (`adb shell` — no App Lab GUI needed). Profile auto-connects on boot by default.
2. **Tailscale**: installed via the standard `curl -fsSL https://tailscale.com/install.sh | sh`,
   authenticated once via browser against the same tailnet as the laptop
   (`qcworkshop24`) and phone (`galaxy-s25-ultra`), `tailscaled.service` enabled at boot. Board
   shows up as `arduino-uno-q` on the tailnet.
3. **SSH key auth to the laptop**: `arduino` user's ed25519 key added to the laptop's
   `C:\ProgramData\ssh\administrators_authorized_keys` (Windows requires this special file, not
   `~\.ssh\authorized_keys`, for accounts in the Administrators group). SSH only ever targets the
   laptop's Tailscale MagicDNS hostname (`qcworkshop24.tail453bf7.ts.net`) — never the USB-C/ADB
   link, which is provisioning-only.
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
