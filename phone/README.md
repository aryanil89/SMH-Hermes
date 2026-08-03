# phone

Samsung Galaxy S25+ (Snapdragon 8 Elite) integration.

- **Baseline**: no code here — the phone just runs the Telegram app and talks to the
  PC-hosted Hermes Agent. Build and verify this first.
- **Stretch goal**: a second on-device inference instance on the phone itself, using the same
  GenieX + Qwen3-4B path as the laptop (QUAD's `android-8elite` target), for a "same agent, two
  devices" demo beat and a phone-vs-laptop NPU benchmark data point. Only attempt after the
  laptop path and Telegram baseline are both solid — see
  [../docs/HARDWARE_UTILIZATION.md](../docs/HARDWARE_UTILIZATION.md).

**Not yet implemented.**
