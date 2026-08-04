import datetime
import json
from arduino.app_utils import App, Bridge

# Relative to the app's working directory inside the App Lab container (/app),
# which is bind-mounted to the app folder on the host. The host-side push to
# the laptop (arduino_uno_q-sensor_log.json) is handled outside this
# container by push_sensor_log.sh, since this container has no ssh/scp.
LOCAL_LOG_PATH = "sensor_log.jsonl"


def button_pressed(event: str, distance_mm: float, celsius: float, humidity: float):
    """Callback invoked by the board sketch via Bridge.notify on each button press
    (rising edge only -- one call per press, not a polling tick). Appends one JSON
    line capturing the simulated event and the sensor readings at that instant.

    Button-to-event mapping (see sketch/sketch.ino BUTTON_EVENTS): A -> door_open,
    B -> light_on, C -> leak_detected.
    """
    reading = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "event": event,
        "temperature_c": celsius,
        "humidity_pct": humidity,
        "distance_mm": distance_mm,
    }

    with open(LOCAL_LOG_PATH, "a") as f:
        f.write(json.dumps(reading) + "\n")


def sensor_tick(event: str, distance_mm: float, celsius: float, humidity: float):
    """Callback for the board's periodic telemetry channel (every ~10s, no human
    involved). Same line shape as button events with event="sensor_tick", so the
    laptop-side reader needs no schema change -- it just sees fresher lines.
    Keeps the environmental MCP tool on real data instead of tripping the
    staleness guard whenever nobody has pressed a button for a while.
    """
    reading = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "event": "sensor_tick",
        "temperature_c": celsius,
        "humidity_pct": humidity,
        "distance_mm": distance_mm,
    }

    with open(LOCAL_LOG_PATH, "a") as f:
        f.write(json.dumps(reading) + "\n")


print("Registering 'button_pressed' callback.")
Bridge.provide("button_pressed", button_pressed)

print("Registering 'sensor_tick' callback.")
Bridge.provide("sensor_tick", sensor_tick)

print("Starting App...")
App.run()
