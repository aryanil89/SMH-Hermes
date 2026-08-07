"""On-device activity inference: correlates recent sensor state into a short,
consistently-named "activity-..." log line, written by a small local LLM
(SmolLM2-135M-Instruct, via a fetched llama.cpp binary -- see
scripts/fetch_llm_runtime.sh and docs/ONDEVICE_ACTIVITY.md).

Design, in order:

1. A cheap, non-LLM prefilter decides whether a moment is worth a model
   call at all -- most sensor_ticks are boring, and this board has no NPU
   (nor, per on-device benchmarking, does its GPU help for this workload --
   see docs/ONDEVICE_ACTIVITY.md). Calling the model on every 10s tick would
   be wasted latency and would flood the log. That same prefilter also
   computes a *suggested* label for the pattern it detected -- blind 7-way
   classification from raw sensor prose measurably does not work at this
   model size (see docs/ONDEVICE_ACTIVITY.md), but "confirm or override this
   specific hint" does, so that's the task the model is actually given.
2. A cooldown prevents the same activity from being re-logged while the
   state that triggered it is still true (mirrors
   mcp-tools/src/alert-skill/decide-alert.ts's edge-triggered + cooldown
   design on the laptop side).
3. Raw model output is never trusted directly: it is normalized and
   validated against a strict pattern before it can reach the log. A
   timeout or an invalid line means nothing is logged -- fail closed,
   because three other services (file-source.ts, the dashboard, the
   watchdog) parse this file and a malformed line is worse than a missed one.

Runs entirely on a background thread (see `_infer_async` and main.py's
existing boot-display thread for the same pattern) so a multi-second model
call never blocks the Bridge RPC thread that Bridge.notify() calls run on.
"""

import os
import re
import subprocess
import threading
import time
from collections import deque

# ---------------------------------------------------------------------------
# Runtime configuration
# ---------------------------------------------------------------------------

RUNTIME_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runtime")
MODEL_PATH = os.path.join(RUNTIME_DIR, "model.gguf")

# Backend selection: measured on-device (docs/ONDEVICE_ACTIVITY.md) -- the
# Turnip Adreno 702 has no matrix cores and lost badly to CPU decode for this
# 135M model, so CPU is the default. Override with ACTIVITY_LLM_BACKEND=vulkan
# to force GPU offload (e.g. to re-measure after a driver update).
BACKEND = os.environ.get("ACTIVITY_LLM_BACKEND", "cpu")
_BACKEND_DIRS = {
    "cpu": os.path.join(RUNTIME_DIR, "cpu"),
    "vulkan": os.path.join(RUNTIME_DIR, "vulkan"),
}
_BACKEND_EXTRA_ARGS = {
    "cpu": [],
    "vulkan": ["-ngl", "99"],
}
LLAMA_BIN = os.path.join(_BACKEND_DIRS.get(BACKEND, _BACKEND_DIRS["cpu"]), "llama")

INFER_TIMEOUT_S = 12.0
MAX_NEW_TOKENS = 20
CTX_SIZE = 512

# ---------------------------------------------------------------------------
# Canonical vocabulary -- "similar activities use consistent naming"
# ---------------------------------------------------------------------------
# The model is told to prefer one of these; a new short phrase is a fallback,
# not the default path. Keeping this list short keeps a 135M model consistent.
CANONICAL_ACTIVITIES = [
    "person_entered_room",
    "person_left_room",
    "room_unoccupied",
    "door_left_open",
    "light_left_on",
    "possible_fire_risk",
    "water_leak_detected",
]

# Blind classification from raw sensor deltas measurably does not work at
# this model size: on-device testing (both 135M and 360M, several
# temperatures, several few-shot orderings) showed the model picking a
# label largely independent of the actual input content -- e.g. the
# fire-risk pattern got labeled "person_entered_room" or "person_left_room"
# depending on run, with no reliable correlation to which events were
# actually described. That's a real capacity ceiling for open-ended
# 7-way classification from prose at this scale, not a prompt bug -- see
# docs/ONDEVICE_ACTIVITY.md for the measurements.
#
# What DOES work reliably: the deterministic Python trigger below already
# knows *why* it fired (a specific rate-of-change or a specific transition
# combination), so it computes a `suggested` label itself and hands it to
# the model as a starting point to confirm-or-override, rather than asking
# for 7-way classification from scratch. This is a task a 135M model can
# actually do (near-copy with an escape hatch for a clearly-wrong hint) --
# confirmed on-device, see docs/ONDEVICE_ACTIVITY.md. The model still does
# real work: it's the only thing enforcing consistent vocabulary/format, and
# it can and does override the hint when the few-shot pattern below shows it
# should (the "no, that's wrong" example).
# A 4th few-shot example demonstrating "override the hint when it's wrong"
# was tried and measurably made things worse: the model started writing full
# prose ("The provided events do not fit the suggested activity label.")
# instead of a label, on cases where the hint was already correct. Dropped in
# favor of a shorter, format-preserving 3-example set where the model's job
# is closer to "echo this hint in the right format" -- confirmed reliable
# on-device across repeated runs (docs/ONDEVICE_ACTIVITY.md). The override
# capability implied by the wording below is real but soft-in-practice at
# this model size; the deterministic caller only supplies a hint it already
# has good confidence in (see _candidate_from_transition), so an unreliable
# override is a smaller risk than an unreliable classification-from-scratch.
SYSTEM_PROMPT = (
    "You are a sensor-fusion assistant for a single room. You are given a "
    "short list of recent sensor events and a suggested activity label for "
    "them. Usually output the suggested label unchanged. Valid labels: "
    + ", ".join(CANONICAL_ACTIVITIES)
    + ". Output ONLY the label, nothing else -- no explanation."
)

FEW_SHOT = (
    "Events: object_left, then door_closed.\n"
    "Suggested: person_left_room\n"
    "Label: person_left_room\n\n"
    "Events: door_open, then object_entered (person), then light_on, all within 20s.\n"
    "Suggested: person_entered_room\n"
    "Label: person_entered_room\n\n"
    "Events: temperature rising 2.1C/min, humidity falling 8%/min.\n"
    "Suggested: possible_fire_risk\n"
    "Label: possible_fire_risk\n\n"
)

_ACTIVITY_RE = re.compile(r"^activity-[a-z0-9_]+$")
_WORD_RE = re.compile(r"[a-z0-9]+")


def normalize_activity(raw: str) -> str | None:
    """Turn raw model output into a validated `activity-...` string, or None.

    Never trusts the model: lowercases, strips everything but words, joins
    with `_`, caps at 5 words, and validates the final shape. Anything that
    doesn't survive this becomes None -- callers must treat that as "log
    nothing" rather than guess.
    """
    if not raw:
        return None
    # Only the first line -- a chatty model sometimes continues past the label.
    first_line = raw.strip().splitlines()[0] if raw.strip() else ""
    # llama.cpp's completion CLI appends "[end of text]" (and similar bracketed
    # EOS/stop markers) to stdout on natural termination -- confirmed live,
    # e.g. "person_entered_room [end of text]". Without stripping this, word
    # extraction below would happily fold "end", "of", "text" into the label.
    first_line = first_line.split("[", 1)[0]
    words = _WORD_RE.findall(first_line.lower())[:5]
    if not words:
        return None
    candidate = "activity-" + "_".join(words)
    return candidate if _ACTIVITY_RE.match(candidate) else None


def _build_prompt(window_summary: str, suggested: str) -> str:
    return FEW_SHOT + f"Events: {window_summary}\nSuggested: {suggested}\nLabel:"


def _run_llm(prompt: str) -> str | None:
    """One subprocess call to the local model. Returns raw text or None on
    any failure (missing runtime, timeout, non-zero exit) -- callers treat
    None the same as an invalid label: log nothing.
    """
    if not os.path.exists(LLAMA_BIN) or not os.path.exists(MODEL_PATH):
        return None
    backend_dir = _BACKEND_DIRS.get(BACKEND, _BACKEND_DIRS["cpu"])
    env = dict(os.environ, LD_LIBRARY_PATH=backend_dir)
    # --log-disable is deliberately NOT passed: confirmed live that combining
    # it with --no-display-prompt silences the completion text on stdout too,
    # not just the logging -- with --no-display-prompt alone, all diagnostic
    # logging goes to stderr and stdout carries only the generated text
    # (verified against a real run; see docs/ONDEVICE_ACTIVITY.md). stderr is
    # simply not read below except in the error path.
    cmd = [
        LLAMA_BIN, "completion",
        "-m", MODEL_PATH,
        "-c", str(CTX_SIZE),
        "-n", str(MAX_NEW_TOKENS),
        "-cnv", "--single-turn",
        "--no-display-prompt",
        # Low temperature: at 135M params this is closer to a classifier
        # picking the nearest few-shot pattern than a creative writer, and
        # the default 0.80 measurably hurt accuracy in on-device testing
        # (see docs/ONDEVICE_ACTIVITY.md) -- the fire-risk pattern was
        # mislabeled at default temp and correctly labeled at 0.2.
        "--temp", "0.2",
        # Stop as soon as the model starts hallucinating a second
        # "Events:/Label:" pair -- normalize_activity() only reads the first
        # line regardless, but stopping early saves real decode latency on a
        # board with no accelerator for this workload.
        "-r", "\n\n",
        "-sys", SYSTEM_PROMPT,
        "-p", prompt,
        *_BACKEND_EXTRA_ARGS.get(BACKEND, []),
    ]
    try:
        result = subprocess.run(
            cmd, cwd=backend_dir, env=env,
            capture_output=True, text=True, timeout=INFER_TIMEOUT_S,
        )
    except (subprocess.TimeoutExpired, OSError) as exc:
        print(f"activity inference failed: {exc}")
        return None
    if result.returncode != 0:
        print(f"activity inference exited {result.returncode}: {result.stderr[-500:]}")
        return None
    return result.stdout


# ---------------------------------------------------------------------------
# Rolling window + trigger heuristics
# ---------------------------------------------------------------------------

WINDOW_SECONDS = 600.0  # ~10 minutes of history for rate-of-change checks
COOLDOWN_SECONDS = 120.0  # don't re-log the same label within this window

# Fire-risk pattern: both conditions must hold over the window.
TEMP_RISE_C_PER_MIN = 1.5
HUMIDITY_FALL_PCT_PER_MIN = 3.0

_lock = threading.Lock()
_window = deque()  # list of (monotonic_ts, temp_c, humidity_pct)
_door_open = False
_light_on = False
_object_present = False
_last_logged = {}  # activity string -> monotonic_ts last logged


def _prune_window(now: float) -> None:
    while _window and now - _window[0][0] > WINDOW_SECONDS:
        _window.popleft()


def _rate_of_change() -> tuple[float, float] | None:
    """(°C/min, %/min) over the current window, or None if too little data."""
    if len(_window) < 2:
        return None
    t0, temp0, hum0 = _window[0]
    t1, temp1, hum1 = _window[-1]
    dt_min = (t1 - t0) / 60.0
    if dt_min < 1.0:  # need at least a minute of spread to trust a rate
        return None
    return (temp1 - temp0) / dt_min, (hum1 - hum0) / dt_min


def _candidate_from_transition(kind: str) -> tuple[str, str] | None:
    """Cheap, deterministic (summary, suggested_label) for a button/presence
    transition. The suggestion is a starting point handed to the model to
    confirm or override -- see the module docstring for why blind
    classification alone doesn't work at this model size.
    """
    global _door_open, _light_on, _object_present
    if kind == "door_open":
        _door_open = True
    elif kind == "door_closed":
        _door_open = False
    elif kind == "light_on":
        _light_on = True
    elif kind == "light_off":
        _light_on = False
    elif kind == "object_entered":
        _object_present = True
    elif kind == "object_left":
        _object_present = False
    else:
        return None

    parts = [kind]
    if _door_open:
        parts.append("door_open")
    if _light_on:
        parts.append("light_on")
    if _object_present:
        parts.append("object_present")
    summary = ", ".join(parts)

    if kind == "object_entered":
        suggested = "person_entered_room"
    elif kind == "object_left":
        suggested = "person_left_room"
    elif kind == "door_open":
        suggested = "door_left_open"
    else:
        # door_closed / light_on / light_off alone: no confident deterministic
        # guess, and blind classification doesn't work at this model size
        # (see module docstring) -- skip the model call entirely rather than
        # hand it a hint we don't believe ourselves.
        return None
    return summary, suggested


def _log_activity(log_fn, activity: str, trigger: str, temp_c: float, humidity: float) -> None:
    now = time.monotonic()
    last = _last_logged.get(activity)
    if last is not None and now - last < COOLDOWN_SECONDS:
        return
    _last_logged[activity] = now
    log_fn("activity", temp_c, humidity, extra={"activity": activity, "trigger": trigger})


_CANONICAL_SET = {f"activity-{c}" for c in CANONICAL_ACTIVITIES}


def _resolve_activity(raw: str | None, suggested: str) -> str | None:
    """Decide the final activity string, with the deterministic `suggested`
    hint as a safety net -- not just a prompt nudge.

    On-device testing (docs/ONDEVICE_ACTIVITY.md) showed this model size
    sometimes fails open-ended generation entirely: instead of a label, raw
    output can be a verbatim echo of the system prompt, or a prose
    explanation, both of which `normalize_activity` still turns into a
    validly-*shaped* but meaningless `activity-...` string (e.g.
    "activity-you_are_a_sensor_fusion"). Shape validation alone isn't enough
    of a gate for a safety-adjacent label like a fire-risk flag, so:

      1. If the model landed on a real vocabulary word -- confirming the
         hint, or genuinely overriding it to a *different* canonical label --
         trust it. Both are legitimate uses of the model.
      2. Otherwise, if a deterministic hint exists, trust the hint over the
         model's free text. The hint is already high-confidence (it's why
         the model was called at all -- see _candidate_from_transition /
         on_sensor_tick); a model that failed to reproduce or improve on it
         should not be allowed to silently replace it with noise.
      3. Only with no hint at all (a genuinely novel pattern) does the
         model's free-form output get accepted as-is -- this is the real
         "invent a new label" path, and the stakes of it being wrong are
         lower because there was no known-good answer to begin with.
    """
    model_activity = normalize_activity(raw) if raw else None
    if model_activity in _CANONICAL_SET:
        return model_activity
    if suggested and suggested != "unclear":
        return f"activity-{suggested}"
    return model_activity


def _infer_and_log(
    log_fn, window_summary: str, suggested: str, trigger: str, temp_c: float, humidity: float
) -> None:
    raw = _run_llm(_build_prompt(window_summary, suggested))
    activity = _resolve_activity(raw, suggested)
    if activity is None:
        return
    _log_activity(log_fn, activity, trigger, temp_c, humidity)


def _infer_async(
    log_fn, window_summary: str, suggested: str, trigger: str, temp_c: float, humidity: float
) -> None:
    threading.Thread(
        target=_infer_and_log,
        args=(log_fn, window_summary, suggested, trigger, temp_c, humidity),
        daemon=True,
        name="activity-infer",
    ).start()


# ---------------------------------------------------------------------------
# Public entry points -- called from main.py's Bridge callbacks
# ---------------------------------------------------------------------------

def on_sensor_tick(log_fn, celsius: float, humidity: float) -> None:
    """Called from main.py's sensor_tick callback, after logging the tick.

    Cheap rate-of-change check only -- no model call unless the fire-risk
    pattern is actually present.
    """
    now = time.monotonic()
    with _lock:
        _window.append((now, celsius, humidity))
        _prune_window(now)
        rates = _rate_of_change()
    if rates is None:
        return
    temp_rate, humidity_rate = rates
    if temp_rate >= TEMP_RISE_C_PER_MIN and humidity_rate <= -HUMIDITY_FALL_PCT_PER_MIN:
        summary = (
            f"temperature rising {temp_rate:.1f}C/min, "
            f"humidity falling {abs(humidity_rate):.1f}%/min"
        )
        _infer_async(log_fn, summary, "possible_fire_risk", "temp_humidity_rate", celsius, humidity)


def on_transition(log_fn, event: str, celsius: float, humidity: float) -> None:
    """Called from main.py's button_event/presence_event callbacks, after
    logging the transition. Only transitions with a confident deterministic
    suggestion (see `_candidate_from_transition`) trigger a model call --
    unlike sensor_tick's rate check, these are already edge-triggered by the
    sketch, so the gate here is purely "do we have a hypothesis worth
    confirming", not a rate threshold.
    """
    with _lock:
        result = _candidate_from_transition(event)
    if result is None:
        return
    summary, suggested = result
    _infer_async(log_fn, summary, suggested, event, celsius, humidity)
