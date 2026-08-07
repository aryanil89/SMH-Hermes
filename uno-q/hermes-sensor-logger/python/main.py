import datetime
import json
import threading
import time

from arduino.app_utils import App, Bridge

import activity

# Relative to the app's working directory inside the App Lab container (/app),
# which is bind-mounted to the app folder on the host. The host-side push to
# the laptop (arduino_uno_q-sensor_log.json) is handled outside this
# container by push_sensor_log.sh, since this container has no ssh/scp.
LOCAL_LOG_PATH = "sensor_log.jsonl"

# Written once a second by push_sensor_log.sh on the host. The container has no
# nmcli/timedatectl/ssh of its own, so this file is the only way in to the
# WiFi / clock / SSH state the boot display reports.
STATUS_PATH = "boot_status.json"

# Stage codes shared with sketch/sketch.ino -- keep in sync with its Stage enum.
STAGE_BOOT = 0
STAGE_WIFI = 1
STAGE_TIME = 2
STAGE_SSH = 3
STAGE_RUN = 4

# Each stage holds the display long enough to actually be read; without this the
# sequence would blink past on a board that connects quickly.
MIN_DWELL_S = 3.0

# How long to keep waiting on a stage that will not come good. Hitting this is
# not fatal: the sequence moves on so the sensor readout still appears, and the
# failing stage has been showing its frown the whole time.
STAGE_TIMEOUT_S = 60.0


def _log_reading(
    event: str,
    celsius: float,
    humidity: float,
    distance_mm: float | None = None,
    extra: dict | None = None,
):
    """Append one JSON line.

    `distance_mm` is omitted entirely when None -- the periodic climate channel
    carries no distance. When present it is -1.0 for "no usable reading", which
    the laptop side already treats as "no sample" rather than a measurement.

    `extra` merges additional fields (e.g. activity.py's `activity`/`trigger`)
    into the record. `event`/`temperature_c`/`humidity_pct` always win over
    `extra` so a caller can never shadow the fields the laptop's
    parseSensorLogLine requires.
    """
    reading = {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        **(extra or {}),
        "event": event,
        "temperature_c": celsius,
        "humidity_pct": humidity,
    }
    if distance_mm is not None:
        reading["distance_mm"] = distance_mm

    with open(LOCAL_LOG_PATH, "a") as f:
        f.write(json.dumps(reading) + "\n")


def button_event(event: str, distance_mm: float, celsius: float, humidity: float):
    """Callback invoked by the sketch on every button *transition* -- both edges,
    one call per change of state, never one per polling tick.

    The buttons model a state rather than a momentary trigger, so each has a
    paired event (see sketch/sketch.ino BUTTON_EVENTS_PRESSED / _RELEASED):
    A -> door_open / door_closed, B -> light_on / light_off,
    C -> leak_detected / leak_cleared.
    """
    _log_reading(event, celsius, humidity, distance_mm)
    # leak_detected/leak_cleared deliberately excluded -- that channel already
    # has its own real detector (button C / distance level, see file-source.ts);
    # running it through the LLM would just add latency to an alert path that
    # is edge-triggered and trusted precisely because it is NOT inferred.
    if event in ("door_open", "door_closed", "light_on", "light_off"):
        activity.on_transition(_log_reading, event, celsius, humidity)


def sensor_tick(event: str, celsius: float, humidity: float):
    """Callback for the board's periodic climate channel (every ~10s, no human
    involved). Temperature and humidity only -- distance is reported by the
    presence channel on crossings instead.

    This channel exists to keep the environmental MCP tool on real data rather
    than tripping its staleness guard whenever nobody has touched the board.
    """
    _log_reading("sensor_tick", celsius, humidity)
    activity.on_sensor_tick(_log_reading, celsius, humidity)


def presence_event(event: str, distance_mm: float, celsius: float, humidity: float):
    """Callback for the ToF presence channel: one line when an object comes within
    the sketch's PRESENCE_THRESHOLD_MM (`object_entered`) and one when it leaves
    again (`object_left`).

    Edge-triggered and debounced in the sketch, so an object parked in front of
    the sensor produces exactly one line on arrival and one on departure -- not a
    line per tick.
    """
    _log_reading(event, celsius, humidity, distance_mm)
    activity.on_transition(_log_reading, event, celsius, humidity)


def _set_stage(stage: int, ok: bool = False, text: str = ""):
    """Push one display stage to the sketch. Never raises: the sketch may not have
    registered set_stage yet (it retries the binding at startup), and a boot
    display that cannot draw must not take the sensor logging down with it.
    """
    try:
        Bridge.call("set_stage", stage, ok, text, timeout=5)
    except Exception as exc:  # noqa: BLE001 - the display is best-effort by design
        print(f"set_stage({stage}, ok={ok}, text={text!r}) failed: {exc}")


def _read_status() -> dict:
    """Read the host's status file. Missing or half-written is normal early in
    boot -- push_sensor_log.sh may not have run yet -- so treat it as 'nothing
    known' rather than an error.
    """
    try:
        with open(STATUS_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _await_stage(stage: int, key: str, text_key: str = "") -> bool:
    """Hold `stage` on the matrix until the host reports `key` true.

    Shows the failure face while waiting and the success face for MIN_DWELL_S
    once it flips, so both outcomes are visible rather than flashing past. Gives
    up after STAGE_TIMEOUT_S so one dead link (no NTP behind a captive portal,
    laptop asleep) cannot strand the display short of the sensor readout.
    """
    deadline = time.monotonic() + STAGE_TIMEOUT_S
    ok = False
    while True:
        status = _read_status()
        ok = bool(status.get(key))
        text = str(status.get(text_key, "")) if text_key else ""
        _set_stage(stage, ok, text)
        if ok:
            break
        if time.monotonic() > deadline:
            print(f"boot stage {stage} ({key}) timed out after {STAGE_TIMEOUT_S}s; continuing")
            break
        time.sleep(1.0)

    time.sleep(MIN_DWELL_S)
    return ok


def _boot_sequence():
    """Walk the matrix through boot -> WiFi -> clock -> SSH -> live readout.

    Runs on its own thread so it never blocks the Bridge callbacks: sensor ticks
    and button events keep being logged throughout, whatever the display shows.
    """
    # The sketch already shows the boot icon from setup(); this re-asserts it in
    # case the app restarted without the board power-cycling.
    _set_stage(STAGE_BOOT)
    time.sleep(MIN_DWELL_S)

    _await_stage(STAGE_WIFI, "wifi_ok")
    _await_stage(STAGE_TIME, "time_ok", text_key="clock")
    _await_stage(STAGE_SSH, "ssh_ok")

    _set_stage(STAGE_RUN)
    print("Boot sequence complete; matrix showing live sensor data.")


print("Registering 'button_event' callback.")
Bridge.provide("button_event", button_event)

print("Registering 'sensor_tick' callback.")
Bridge.provide("sensor_tick", sensor_tick)

print("Registering 'presence_event' callback.")
Bridge.provide("presence_event", presence_event)

print("Starting boot status display thread.")
threading.Thread(target=_boot_sequence, name="boot-display", daemon=True).start()

print("Starting App...")
App.run()
