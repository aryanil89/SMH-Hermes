"""Cycle the LED matrix through every boot-display stage so the icons can be
checked by eye. Not part of the app -- main.py never imports this.

Sensor logging is untouched while this runs: the stage only changes what the
matrix draws, and the sequence ends back on the live readout (STAGE_RUN).

Run it from the laptop with the board on USB:

    adb shell 'docker exec hermes-sensor-logger-main-1 \
        python3 /app/python/show_boot_stages.py 4'

The optional argument is seconds per stage (default 4).
"""

import sys
import time

from arduino.app_utils import Bridge

# Must match sketch/sketch.ino's Stage enum and main.py's STAGE_* constants.
STAGES = [
    (0, False, "", "BOOT      -> boot icon"),
    (1, False, "", "WIFI fail -> wifi arcs + frown face"),
    (1, True, "", "WIFI ok   -> wifi arcs + check mark"),
    (2, True, "12:34", "TIME      -> scrolling clock"),
    (3, False, "", "SSH fail  -> 'SSH' alternating with frown"),
    (3, True, "", "SSH ok    -> 'SSH' alternating with check"),
    (4, False, "", "RUN       -> live sensor readout"),
]


def main():
    dwell = float(sys.argv[1]) if len(sys.argv) > 1 else 4.0
    for stage, ok, text, label in STAGES:
        print(label, flush=True)
        Bridge.call("set_stage", stage, ok, text, timeout=5)
        time.sleep(dwell)
    print("done -- matrix is back on the live sensor readout", flush=True)


if __name__ == "__main__":
    main()
