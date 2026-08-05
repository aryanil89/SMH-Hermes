#!/bin/bash
# Runs on the Uno Q's Linux host (not inside the App Lab container, which has
# no ssh/scp). Started by the hermes-sensor-logger-push systemd unit, loops
# forever, and does two jobs off a 1-second tick:
#
#   1. boot_status.json -- WiFi / clock / SSH state for the LED matrix boot
#      display. Written every tick because the matrix is meant to track the
#      connect sequence as it happens. python/main.py reads it through the
#      bind-mounted app directory and drives the sketch over the Bridge.
#   2. sensor_log push -- the same 10s scp cadence to the laptop as before.
#
# The probing lives out here rather than in main.py because nmcli, timedatectl
# and ssh only exist on the host: the app container has none of them.

APP_DIR="/home/arduino/ArduinoApps/hermes-sensor-logger"
LOCAL_LOG="$APP_DIR/sensor_log.jsonl"
STATUS_FILE="$APP_DIR/boot_status.json"
# Deployment-specific: the laptop's Tailscale MagicDNS name and Windows user.
# Set via environment or edit the defaults; deliberately not committed.
SSH_TARGET="${SENSOR_PUSH_TARGET:-<windows-user>@<laptop-tailnet-host>}"
REMOTE_PATH="${SENSOR_PUSH_PATH:-C:/Users/<windows-user>/Downloads/QUAD/SMH-Hermes/arduino_uno_q-sensor_log.json}"

PRUNE_SCRIPT="$APP_DIR/prune_sensor_log.py"

PUSH_EVERY=10      # ticks between scp pushes
SSH_CHECK_EVERY=10 # ticks between ssh probes -- a full handshake is far too
                   # slow to run every tick, so its result is cached between runs
PRUNE_EVERY=3600   # ticks between log prunes. Hourly is plenty: at ~2.1k
                   # lines/day the file cannot grow enough in an hour to matter,
                   # and a rarer prune means fewer atomic replaces racing the
                   # container's appends.

tick=0
ssh_ok=false

while true; do
  # --- WiFi: the active connection profile bound to wlan0, if any ----------
  ssid="$(nmcli -t -f NAME,DEVICE con show --active 2>/dev/null \
          | awk -F: '$2=="wlan0"{print $1; exit}')"
  if [ -n "$ssid" ]; then wifi_ok=true; else wifi_ok=false; fi

  # --- Clock: NTP's own verdict, plus a year check ------------------------
  # The year test catches the no-RTC-battery 1970 boot even in the window
  # before timesyncd has made up its mind.
  if [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = "yes" ] \
     && [ "$(date -u +%Y)" -ge 2025 ]; then
    time_ok=true
  else
    time_ok=false
  fi
  clock="$(date -u +%H:%M)"

  # --- SSH: a real auth attempt, not just a port probe --------------------
  # A reachable host with a broken key is still a failure for the push path
  # this display reports on, so an actual authenticated command is the honest
  # test. It must be `exit 0` and not `true`: the laptop's SSH shell is
  # PowerShell, where `true` is not a command and every probe would report a
  # false failure even though the link is fine.
  if [ $((tick % SSH_CHECK_EVERY)) -eq 0 ]; then
    if ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
         "$SSH_TARGET" "exit 0" >/dev/null 2>&1; then
      ssh_ok=true
    else
      ssh_ok=false
    fi
  fi

  # Write to a temp file and move it into place so the container never reads a
  # half-written status file.
  printf '{"wifi_ok": %s, "ssid": "%s", "time_ok": %s, "clock": "%s", "ssh_ok": %s}\n' \
    "$wifi_ok" "$ssid" "$time_ok" "$clock" "$ssh_ok" > "$STATUS_FILE.tmp"
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"

  # --- Prune --------------------------------------------------------------
  # Hourly, and BEFORE the push, so the very next scp is the smaller file
  # rather than shipping the fat one once more. The scp above re-sends the
  # whole log every 10s, so the log's size is a bandwidth cost six times a
  # minute, not a disk cost -- capping it is the entire point.
  #
  # Guarded by flock: a prune that overruns the hour must not have a second
  # copy start on top of it and race the atomic replace.
  if [ $((tick % PRUNE_EVERY)) -eq 0 ] && [ -f "$PRUNE_SCRIPT" ]; then
    flock -n "$APP_DIR/.prune.lock" python3 "$PRUNE_SCRIPT" \
      || echo "push_sensor_log: prune skipped (already running or failed)"
  fi

  # --- Push ---------------------------------------------------------------
  if [ $((tick % PUSH_EVERY)) -eq 0 ] && [ -f "$LOCAL_LOG" ]; then
    scp -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
      "$LOCAL_LOG" "$SSH_TARGET:$REMOTE_PATH" \
      || echo "push_sensor_log: scp failed, will retry next cycle"
  fi

  tick=$((tick + 1))
  sleep 1
done
