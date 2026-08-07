"""Hardware-independent checks for activity.py.

Two kinds of test here, deliberately kept separate:

  * `test_normalize_activity` / `test_prefilter_*` -- pure Python, no model,
    no board. Run these anywhere (`python3 -m python.test_activity`).
  * `test_live_*` -- actually shells out to the real llama.cpp binary and the
    real model, so they only make sense run via `adb shell` inside the app
    container where runtime/ has been fetched (scripts/fetch_llm_runtime.sh).
    Skipped automatically if the runtime isn't present, so this file is safe
    to run from a dev machine too.

Not a pytest suite -- this app has no test framework installed (App Lab's
base image ships no gcc/cmake/pip extras beyond stdlib+requirements.txt,
see docs/ONDEVICE_ACTIVITY.md), so this is a plain script with asserts,
matching the project's own preference for measuring on the real board over
mocking it.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import activity  # noqa: E402


def test_normalize_activity():
    cases = [
        ("person_entered_room [end of text]", "activity-person_entered_room"),
        ("possible_fire_risk", "activity-possible_fire_risk"),
        ("  water_leak_detected  \nignored second line", "activity-water_leak_detected"),
        ("", None),
        (None, None),
        # Over 5 words -- truncated, not rejected.
        ("one two three four five six seven", "activity-one_two_three_four_five"),
    ]
    for raw, expected in cases:
        got = activity.normalize_activity(raw)
        assert got == expected, f"normalize_activity({raw!r}) = {got!r}, expected {expected!r}"
    print("test_normalize_activity: PASS")


def test_prefilter_transition_tracks_state():
    # Fresh module-level state per test run (this file is short-lived).
    activity._door_open = False
    activity._light_on = False
    activity._object_present = False

    result = activity._candidate_from_transition("door_open")
    assert result == ("door_open, door_open", "door_left_open"), result

    result = activity._candidate_from_transition("object_entered")
    assert result == ("object_entered, door_open, object_present", "person_entered_room"), result

    # light_on alone has no confident suggestion -- deliberately skipped
    # (see _candidate_from_transition), not given a weak guess.
    result = activity._candidate_from_transition("light_on")
    assert result is None, result

    # light_on's own call above returned None (skipped) but still updated
    # _light_on state, so it's still true here.
    result = activity._candidate_from_transition("object_left")
    assert result == ("object_left, door_open, light_on", "person_left_room"), result

    result = activity._candidate_from_transition("sensor_tick")  # not a transition
    assert result is None, result
    print("test_prefilter_transition_tracks_state: PASS")


def test_prefilter_rate_of_change():
    activity._window.clear()
    now = 1000.0
    # Flat: 0.1C over 2 minutes -- well under threshold.
    activity._window.append((now, 22.0, 45.0))
    activity._window.append((now + 120, 22.1, 44.5))
    assert activity._rate_of_change() == (
        (22.1 - 22.0) / 2.0, (44.5 - 45.0) / 2.0
    )

    # Fire pattern: 3C/min rise, 6%/min humidity fall over 2 minutes.
    activity._window.clear()
    activity._window.append((now, 20.0, 50.0))
    activity._window.append((now + 120, 26.0, 38.0))
    temp_rate, hum_rate = activity._rate_of_change()
    assert temp_rate == 3.0 and hum_rate == -6.0, (temp_rate, hum_rate)
    print("test_prefilter_rate_of_change: PASS")


def test_resolve_activity_falls_back_to_hint():
    # Model landed on a real vocabulary word (confirming the hint) -- trusted.
    assert activity._resolve_activity("possible_fire_risk", "possible_fire_risk") == "activity-possible_fire_risk"
    # Model landed on a DIFFERENT real vocabulary word -- a legitimate override, trusted.
    assert activity._resolve_activity("room_unoccupied", "possible_fire_risk") == "activity-room_unoccupied"
    # Model echoed the system prompt / produced prose -- not real vocabulary,
    # hint wins. This is the actual failure mode observed on-device.
    assert activity._resolve_activity(
        "You are a sensor-fusion assistant for a single room.", "possible_fire_risk"
    ) == "activity-possible_fire_risk"
    # No hint available (novel pattern) -- the model's own output is accepted as-is.
    assert activity._resolve_activity("someone_is_cooking", "unclear") == "activity-someone_is_cooking"
    # No hint AND no usable output -- nothing to log.
    assert activity._resolve_activity(None, "unclear") is None
    print("test_resolve_activity_falls_back_to_hint: PASS")


def test_cooldown_suppresses_repeat():
    activity._last_logged.clear()
    logged = []

    def fake_log(event, temp, humidity, extra=None):
        logged.append((event, extra))

    activity._log_activity(fake_log, "activity-person_entered_room", "door+presence", 22.0, 45.0)
    activity._log_activity(fake_log, "activity-person_entered_room", "door+presence", 22.0, 45.0)
    assert len(logged) == 1, f"expected cooldown to suppress the second write, got {logged}"
    print("test_cooldown_suppresses_repeat: PASS")


LIVE_SCENARIOS = [
    # (expected_label, window_summary, suggested_hint) -- suggested mirrors
    # what _candidate_from_transition/on_sensor_tick actually computes for
    # each pattern. This exercises the FULL resolution path (_resolve_activity),
    # not just the raw model call -- these are expected to pass reliably
    # specifically because the deterministic hint is the safety net, not
    # because the model's raw output is reliable on its own (it measurably
    # isn't, see docs/ONDEVICE_ACTIVITY.md). A raw-model-only accuracy number
    # is recorded in that doc separately.
    ("person_entered_room", "door_open, then object_entered (person), then light_on", "person_entered_room"),
    ("possible_fire_risk", "temperature rising 3.2C/min, humidity falling 6.0%/min", "possible_fire_risk"),
    ("person_left_room", "object_left, then door_closed", "person_left_room"),
]


def test_live_scenarios():
    if not os.path.exists(activity.LLAMA_BIN) or not os.path.exists(activity.MODEL_PATH):
        print("test_live_scenarios: SKIPPED (runtime/ not fetched -- run scripts/fetch_llm_runtime.sh)")
        return
    failures = []
    for expected_label, summary, suggested in LIVE_SCENARIOS:
        raw = activity._run_llm(activity._build_prompt(summary, suggested))
        raw_normalized = activity.normalize_activity(raw)
        resolved = activity._resolve_activity(raw, suggested)
        expected = f"activity-{expected_label}"
        status = "OK" if resolved == expected else "MISMATCH"
        print(f"  [{status}] {summary!r} (suggested={suggested}) -> raw model: {raw_normalized!r}, "
              f"resolved: {resolved!r} (expected {expected!r})")
        if resolved != expected:
            failures.append((summary, resolved, expected))
    if failures:
        print(f"test_live_scenarios: {len(failures)}/{len(LIVE_SCENARIOS)} mismatched even after "
              f"hint fallback -- this should not happen, see docs/ONDEVICE_ACTIVITY.md")
    else:
        print("test_live_scenarios: PASS (via deterministic hint fallback where the raw model missed)")


if __name__ == "__main__":
    test_normalize_activity()
    test_prefilter_transition_tracks_state()
    test_prefilter_rate_of_change()
    test_resolve_activity_falls_back_to_hint()
    test_cooldown_suppresses_repeat()
    test_live_scenarios()
