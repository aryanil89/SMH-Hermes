#!/bin/bash
# Runs on the Uno Q's Linux host (not inside the App Lab container, which has
# no ssh/scp). Every 10s, overwrites the laptop's copy of the sensor log with
# the local JSON-lines file the app container is appending to. Loops forever;
# started by the hermes-sensor-logger-push systemd unit.

LOCAL_LOG="/home/arduino/ArduinoApps/hermes-sensor-logger/sensor_log.jsonl"
SSH_TARGET="qc_de@qcworkshop24.tail453bf7.ts.net"
REMOTE_PATH="C:/Users/qc_de/Downloads/QUAD/SMH-Hermes/arduino_uno_q-sensor_log.json"

while true; do
  if [ -f "$LOCAL_LOG" ]; then
    scp -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
      "$LOCAL_LOG" "$SSH_TARGET:$REMOTE_PATH" \
      || echo "push_sensor_log: scp failed, will retry next cycle"
  fi
  sleep 10
done
