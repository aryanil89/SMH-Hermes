"""Tell the phone the message landed, before the long silence starts.

A tool-calling turn on this stack costs 60-300 s (full-prompt re-prefill; there
is no KV cache in GenieX v0.3.18). Until this hook existed the phone showed
nothing in that window but a Telegram "typing..." bubble -- which expires in
~5 s between refreshes, never reaches the notification shade, and looks
identical whether the gateway is thinking or dead. Every failure mode and the
healthy path presented as the same thing: silence.

So the gateway now answers twice. First a receipt, within a couple of seconds:
one line, written by the local model, naming what was actually asked and
carrying an estimate of how long the real answer will take. Then the answer.

## Why the receipt is generated *before* the agent's first model call

`agent:start` is emitted immediately before `_run_agent` (`gateway/run.py`), and
`HookRegistry.emit` awaits its handlers. That ordering is the whole design:
**GenieX serializes every request** (measured: 654 us idle vs 1m42s queued
behind one completion -- see the README troubleshooting table). A receipt
generated in a background task would be queued *behind* the turn it announces
and arrive after the answer it was supposed to precede.

Blocking here costs the turn one short completion -- ~2 s measured warm, ~200
prompt tokens and <=48 out -- on a 60-300 s turn. When the model has unloaded
(`--keepalive` idle), this call pays the reload the turn was going to pay
anyway, and the agent's own request then finds a warm model, so the cost is
close to zero on exactly the turns that felt worst.

The HTTP calls run on threads: `emit` runs on the gateway's event loop, and
blocking it would stall the typing-indicator cadence and the adapter heartbeats.

## What it will not do

Fail loudly, and never delay a turn without bound. Any error -- model down,
timeout, no token, Telegram unreachable -- degrades to a canned line that still
carries the estimate, and past `HERMES_ACK_TIMEOUT_S` the receipt goes out
canned rather than waiting. `HookRegistry.emit` swallows exceptions, but a hook
that leaned on that would fail *silently*; this one is written so there is
nothing to swallow.

It also reports no findings. The receipt is written before a single tool has
run, so the prompt forbids readings, numbers and "all clear" -- a witty line
that invents a status would be worse than the silence it replaces.

## Where the estimate comes from

Measured turns, this session's own. `agent:end` records the duration, and the
estimate is the median of the last few, leaning late because sessions grow
(prompt size is the only latency lever here). With no history yet it falls back
to the measured priors in `llm-serving-bench/RESULTS.md`: ~1 min/turn on a fresh
session, ~5 min near the 32K compression ceiling.

The number is owned by this file, not by the model: the model is asked to end
its line with the estimate verbatim, and if it doesn't, the estimate is appended.
A 4B model will not be trusted to get an arithmetic claim right.

Self-test (no gateway, no Telegram):

    python handler.py --selftest          # offline: buckets, sanitiser, fallbacks
    python handler.py --try "is rack B1 hot?"   # one live receipt, printed not sent
"""

from __future__ import annotations

import asyncio
import html
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------
# Knobs. Every one optional; the defaults are the demo configuration.
# --------------------------------------------------------------------------

_TRUTHY = {"1", "true", "yes", "on"}

#: Hard ceiling on how long a receipt may delay the turn it announces.
_DEFAULT_TIMEOUT_S = 12.0
#: Telegram is a cloud hop and may be the thing that's broken. Fail fast.
_SEND_TIMEOUT_S = 6.0
_MAX_TOKENS = 48
#: Longer than this and it stops being a receipt.
_MAX_ACK_CHARS = 180
#: Enough of the message to name the subject; the rest is prefill we don't need.
_MAX_MESSAGE_CHARS = 220

_FALLBACK_BASE_URL = "http://127.0.0.1:18181/v1"
_FALLBACK_MODEL = "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0"


def _flag(name: str, default: bool = True) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in _TRUTHY


def _float_env(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, "").strip())
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _hermes_home() -> Path:
    raw = os.environ.get("HERMES_HOME", "").strip()
    if raw:
        return Path(raw).expanduser()
    local = os.environ.get("LOCALAPPDATA", "").strip()
    if local:
        return Path(local) / "hermes"
    return Path.home() / ".hermes"


def _state_path() -> Path:
    return _hermes_home() / "state" / "ack-hook.json"


# --------------------------------------------------------------------------
# Endpoint. Read Hermes' own config so the receipt cannot drift onto a
# different model or port than the agent is using.
# --------------------------------------------------------------------------

_endpoint_cache: tuple[str, str] | None = None


def _endpoint() -> tuple[str, str]:
    """Return ``(chat_completions_url, model_id)``."""
    global _endpoint_cache
    if _endpoint_cache is not None:
        return _endpoint_cache

    base_url = os.environ.get("HERMES_ACK_BASE_URL", "").strip()
    model = os.environ.get("HERMES_ACK_MODEL", "").strip()

    if not base_url or not model:
        try:
            import yaml  # provided by the gateway venv

            loaded = yaml.safe_load(
                (_hermes_home() / "config.yaml").read_text(encoding="utf-8")
            )
            section = (loaded or {}).get("model") or {}
            base_url = base_url or str(section.get("base_url") or "").strip()
            model = model or str(section.get("default") or "").strip()
        except Exception:
            pass

    base_url = base_url or _FALLBACK_BASE_URL
    model = model or _FALLBACK_MODEL
    _endpoint_cache = (base_url.rstrip("/") + "/chat/completions", model)
    return _endpoint_cache


def _bot_token() -> str:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if token:
        return token
    # The gateway loads HERMES_HOME/.env into its environment, so this is only
    # reached by the self-test and by an oddly-launched gateway.
    try:
        for line in (_hermes_home() / ".env").read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == "TELEGRAM_BOT_TOKEN":
                return value.strip().strip('"').strip("'")
    except Exception:
        pass
    return ""


# --------------------------------------------------------------------------
# Turn history -> wait estimate
# --------------------------------------------------------------------------

#: Fresh session, first turns: ~1 min (RESULTS.md, "Session token budget").
_PRIOR_FIRST_TURN_S = 90.0
_PRIOR_S = 75.0
#: Compression fires at 32K and caps the worst measured turn at 293 s.
_ETA_CEILING_S = 300.0
_HISTORY_KEPT = 5
_SESSIONS_KEPT = 40
_SESSION_TTL_S = 24 * 3600

_MINUTE_WORDS = {
    1: "about a minute",
    2: "about two minutes",
    3: "about three minutes",
    4: "about four minutes",
    5: "about five minutes",
}
_DIGIT_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}


def _read_state() -> dict[str, Any]:
    try:
        loaded = json.loads(_state_path().read_text(encoding="utf-8"))
    except Exception:
        return {"sessions": {}}
    if not isinstance(loaded, dict) or not isinstance(loaded.get("sessions"), dict):
        return {"sessions": {}}
    return loaded


def _touched(entry: Any) -> float:
    try:
        return float((entry or {}).get("touched") or 0)
    except (AttributeError, TypeError, ValueError):
        return 0.0


def _write_state(state: dict[str, Any]) -> None:
    sessions = state.get("sessions") or {}
    now = time.time()
    fresh = {
        key: value
        for key, value in sessions.items()
        if isinstance(value, dict) and now - _touched(value) < _SESSION_TTL_S
    }
    if len(fresh) > _SESSIONS_KEPT:
        newest = sorted(fresh.items(), key=lambda kv: _touched(kv[1]), reverse=True)
        fresh = dict(newest[:_SESSIONS_KEPT])
    state["sessions"] = fresh

    path = _state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Write-then-replace: a half-written file here would poison every later
        # estimate, and this runs while a turn is in flight.
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2), encoding="utf-8")
        tmp.replace(path)
    except Exception:
        pass


def estimate_seconds(durations: list[float]) -> float:
    """Predict this turn from the ones before it.

    Median of the recent window, floored at the most recent turn and nudged up:
    sessions only grow, prompt size is the only latency lever, so a symmetric
    estimator is biased low on every turn but the first.
    """
    recent = [d for d in durations[-_HISTORY_KEPT:] if isinstance(d, (int, float)) and d > 0]
    if not recent:
        return _PRIOR_FIRST_TURN_S if not durations else _PRIOR_S
    ordered = sorted(recent)
    median = ordered[len(ordered) // 2]
    return min(max(median, recent[-1]) * 1.1, _ETA_CEILING_S)


def eta_phrase(seconds: float) -> tuple[str, int | None]:
    """Return ``(human phrase, minutes)``; ``minutes`` is None for sub-minute."""
    if seconds < 45:
        return "under a minute", None
    minutes = max(1, min(5, int(round(seconds / 60.0))))
    return _MINUTE_WORDS[minutes], minutes


def mentions_eta(text: str, minutes: int | None) -> bool:
    """Did the model actually carry the estimate through?

    Deliberately loose about digits vs words ("2 minutes" and "two minutes" both
    pass) and strict about the unit, so the repair below only fires when the
    estimate is genuinely absent rather than merely reworded.
    """
    lowered = text.lower()
    if minutes is None:
        return "minute" in lowered and ("under" in lowered or "less" in lowered)
    pattern = rf"\b({minutes}|{_DIGIT_WORDS[minutes]}{'|a' if minutes == 1 else ''})\b[^.!?]{{0,16}}minute"
    return re.search(pattern, lowered) is not None


# --------------------------------------------------------------------------
# The receipt itself
# --------------------------------------------------------------------------

_SYSTEM_PROMPT = (
    "You write the one-line receipt Hermes sends the instant a message arrives. Hermes is "
    "an on-device datacenter operations agent; the real answer takes minutes, so this line "
    "only says the message landed and work has started.\n"
    "Rules:\n"
    "- One sentence, under 16 words, dry wit.\n"
    "- Name the subject they asked about, so the line could only be a reply to this message.\n"
    "- Describe only what you are STARTING to do. You have not looked yet, so you know "
    "nothing: no readings, no numbers, no status, no 'no signs of', no 'nothing yet', "
    "no 'all clear'.\n"
    "- End with the wait estimate, copied verbatim.\n"
    "- No emoji, no quotes, no markdown, no questions.\n"
    "Examples:\n"
    "Message: is the cooling loop ok / Wait: about a minute\n"
    "-> On the cooling loop now, reading the sensors properly - about a minute.\n"
    "Message: any packet loss on rack-b1 / Wait: about two minutes\n"
    "-> Counting rack-b1 packets, no shortcuts - about two minutes.\n"
    "Message: is the UPS still on battery / Wait: about two minutes\n"
    "WRONG (states a finding it has not looked up): Checking the UPS, no alarms yet - about "
    "two minutes.\n"
    "RIGHT: Walking the UPS log now, every transfer in it - about two minutes."
)

#: A receipt is written before a single tool has run, so any status claim in it
#: is invented. The prompt above suppresses these; this is the backstop that
#: makes it a guarantee, because a small model will occasionally ignore a brief
#: and a confident fabricated "no alerts" is worse than the silence we replaced.
_CLAIM_PATTERN = re.compile(
    r"\bno (signs?|alerts?|issues?|problems?|anomal\w*|errors?|entr(?:y|ies)|activity|"
    r"faults?|changes?|movement|breaches?|leaks?)\b"
    r"|\b(all|everything)\s+(clear|good|normal|fine|quiet|looks|seems|appears)\b"
    r"|\bnothing\b"
    r"|\b(looks|seems|appears)\s+(fine|ok|okay|normal|good|healthy|stable)\b"
    r"|\b(found|detected|recorded|logged|shows?)\s+(no|zero|none)\b"
    r"|\b\d+(\.\d+)?\s*(°|deg|c\b|f\b|%|kw\b|w\b|ms\b|mbps\b|gb\b)",
    re.IGNORECASE,
)

_FALLBACKS = (
    "Message received, work started - {eta}.",
    "That landed; I am on it - {eta}.",
    "Got it, and already digging - {eta}.",
    "Noted and queued, no shortcuts - {eta}.",
)

#: Openers a small model reaches for when it ignores the brief.
_REFUSAL_MARKERS = (
    "as an ai",
    "i cannot",
    "i can't",
    "sure!",
    "here is",
    "here's a",
)


def sanitize(raw: str) -> str:
    """First line only, markdown stripped, length-capped."""
    text = (raw or "").strip()
    # Some small models still emit a reasoning preamble; keep the last non-empty
    # line when the first looks like scaffolding.
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if not lines:
        return ""
    text = lines[-1] if lines[0].endswith(":") and len(lines) > 1 else lines[0]
    text = re.sub(r"^\s*(?:->|-|\*|\d+[.)])\s*", "", text)
    text = text.strip().strip('"').strip("'").strip()
    text = re.sub(r"[*`_~]+", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > _MAX_ACK_CHARS:
        text = text[:_MAX_ACK_CHARS].rsplit(" ", 1)[0].rstrip(",;:-") + "..."
    lowered = text.lower()
    if any(marker in lowered for marker in _REFUSAL_MARKERS):
        return ""
    return text


def claims_a_finding(text: str) -> str:
    """Return the offending phrase, or "" when the line asserts nothing."""
    match = _CLAIM_PATTERN.search(text or "")
    return match.group(0) if match else ""


def compose(raw: str, phrase: str, minutes: int | None, message: str) -> str:
    """Turn a model line into a receipt that is guaranteed to carry the estimate."""
    text = sanitize(raw)
    claim = claims_a_finding(text)
    if claim:
        print(f"[hooks:ack] dropped an invented finding: {claim!r}", flush=True)
    if not text or claim:
        picker = random.Random(f"{message}|{int(time.time() // 60)}")
        return picker.choice(_FALLBACKS).format(eta=phrase)
    if not mentions_eta(text, minutes):
        text = text.rstrip(" .!,;:-") + f" - {phrase}."
    return text


def _post_json(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def _generate_blocking(message: str, phrase: str, timeout: float) -> str:
    url, model = _endpoint()
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": _SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"Message: {message[:_MAX_MESSAGE_CHARS]} / Wait: {phrase}",
            },
        ],
        # High temperature is the point: two people asking the same question on
        # the same day should not get the same sentence back.
        "max_tokens": _MAX_TOKENS,
        "temperature": 0.95,
        "top_p": 0.95,
    }
    body = _post_json(url, payload, timeout)
    choices = body.get("choices") or []
    if not choices:
        return ""
    return str((choices[0].get("message") or {}).get("content") or "")


def _send_blocking(token: str, chat_id: str, text: str, thread_id: str, chat_type: str) -> None:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        # Italic so the receipt is never mistaken for the answer -- on a phone
        # that difference has to survive a glance at a notification.
        "text": f"<i>{html.escape(text)}</i>",
        "parse_mode": "HTML",
    }
    # Only forums carry a topic id. Sending message_thread_id into a plain group
    # is a 400, and hooks.py documents the forum condition explicitly.
    if chat_type == "forum" and thread_id:
        try:
            payload["message_thread_id"] = int(thread_id)
        except (TypeError, ValueError):
            pass
    try:
        _post_json(url, payload, _SEND_TIMEOUT_S)
    except urllib.error.HTTPError as err:
        # 400 here is almost always parse_mode; the receipt matters more than
        # the italics, so retry once as plain text.
        if err.code != 400:
            raise
        payload.pop("parse_mode", None)
        payload["text"] = text
        _post_json(url, payload, _SEND_TIMEOUT_S)


# --------------------------------------------------------------------------
# Hook entry point
# --------------------------------------------------------------------------


async def _on_start(context: dict[str, Any]) -> None:
    session_id = str(context.get("session_id") or "")
    chat_id = str(context.get("chat_id") or "")
    message = str(context.get("message") or "").strip()
    if not chat_id:
        return

    state = _read_state()
    entry = state["sessions"].setdefault(session_id, {})
    entry["started"] = time.time()
    entry["touched"] = time.time()
    durations = [d for d in (entry.get("durations") or []) if isinstance(d, (int, float))]
    _write_state(state)

    phrase, minutes = eta_phrase(estimate_seconds(durations))

    raw = ""
    timeout = _float_env("HERMES_ACK_TIMEOUT_S", _DEFAULT_TIMEOUT_S)
    if message:
        try:
            raw = await asyncio.wait_for(
                asyncio.to_thread(_generate_blocking, message, phrase, timeout),
                timeout=timeout,
            )
        except Exception as err:
            # Expected whenever GenieX is down or reloading. The receipt still
            # goes out; it is the silence this hook exists to remove.
            print(f"[hooks:ack] receipt fell back to canned text: {err!r}", flush=True)

    text = compose(raw, phrase, minutes, message)

    token = _bot_token()
    if not token:
        print("[hooks:ack] TELEGRAM_BOT_TOKEN unset; receipt not sent", flush=True)
        return
    try:
        await asyncio.to_thread(
            _send_blocking,
            token,
            chat_id,
            text,
            str(context.get("thread_id") or ""),
            str(context.get("chat_type") or "").lower(),
        )
    except Exception as err:
        print(f"[hooks:ack] could not send receipt: {err!r}", flush=True)


def _on_end(context: dict[str, Any]) -> None:
    session_id = str(context.get("session_id") or "")
    state = _read_state()
    entry = state["sessions"].get(session_id)
    if not isinstance(entry, dict) or not entry.get("started"):
        return  # hook installed mid-turn, or a turn we never acknowledged
    try:
        elapsed = time.time() - float(entry["started"])
    except (TypeError, ValueError):
        elapsed = -1.0
    entry.pop("started", None)
    entry["touched"] = time.time()
    # A turn that returned instantly was served from somewhere other than the
    # model (command, cached refusal) and would drag every later estimate down.
    if 2.0 < elapsed < 3600.0:
        durations = [d for d in (entry.get("durations") or []) if isinstance(d, (int, float))]
        durations.append(round(elapsed, 1))
        entry["durations"] = durations[-_HISTORY_KEPT:]
    _write_state(state)


async def handle(event_type: str, context: dict[str, Any]) -> None:
    if not _flag("HERMES_ACK_ENABLED"):
        return
    # Telegram is the only surface with the silence problem: the CLI streams
    # status locally and the wall renders the transcript as it is written.
    if str(context.get("platform") or "").lower() != "telegram":
        return
    if event_type == "agent:start":
        await _on_start(context)
    elif event_type == "agent:end":
        await asyncio.to_thread(_on_end, context)


# --------------------------------------------------------------------------
# Self-test -- runnable without the gateway, Telegram, or a warm model
# --------------------------------------------------------------------------


def _selftest() -> int:
    failures: list[str] = []

    def check(label: str, ok: bool) -> None:
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}")
        if not ok:
            failures.append(label)

    print("estimate + buckets")
    check("no history -> first-turn prior", estimate_seconds([]) == _PRIOR_FIRST_TURN_S)
    check("median leans late", 60 < estimate_seconds([50.0, 60.0, 70.0]) < 90)
    check("ceiling holds", estimate_seconds([600.0, 600.0]) == _ETA_CEILING_S)
    check("sub-minute bucket", eta_phrase(30.0) == ("under a minute", None))
    check("one-minute bucket", eta_phrase(70.0) == ("about a minute", 1))
    check("five-minute bucket", eta_phrase(293.0) == ("about five minutes", 5))

    print("estimate carried through")
    check("word form accepted", mentions_eta("On it - about two minutes.", 2))
    check("digit form accepted", mentions_eta("On it, about 2 minutes.", 2))
    check("article form accepted", mentions_eta("Reading it now - about a minute.", 1))
    check("wrong number rejected", not mentions_eta("about four minutes", 2))
    check("sub-minute accepted", mentions_eta("Back in under a minute.", None))
    check("bare unit rejected", not mentions_eta("this will take minutes", None))

    print("sanitiser")
    check("markdown stripped", sanitize("**On it** - `now`") == "On it - now")
    check("quotes stripped", sanitize('"On the cooling loop."') == "On the cooling loop.")
    check("bullet stripped", sanitize("-> On it now") == "On it now")
    check("first line kept", sanitize("On it now\nAlso the temp is 22C") == "On it now")
    check("refusal rejected", sanitize("As an AI, I cannot do that") == "")
    check("length capped", len(sanitize("word " * 200)) <= _MAX_ACK_CHARS + 3)

    print("invented findings are refused")
    for line in (
        "Checking the cage door log, no entries yet - about two minutes.",
        "On the racks now, everything looks fine - about a minute.",
        "Reading rack B1, currently 22.4C - about a minute.",
        "Sweeping for smoke, nothing so far - about a minute.",
        "Pulling the link stats, detected no packet loss - about two minutes.",
    ):
        check(f"caught: {line[:34]}...", bool(claims_a_finding(line)))
    for line in (
        "Pulling the cage door log now, every swipe of it - about two minutes.",
        "Counting rack-b1 packets, no shortcuts - about two minutes.",
        "On the cooling loop now, reading the sensors properly - about a minute.",
    ):
        check(f"allowed: {line[:34]}...", not claims_a_finding(line))
    for template in _FALLBACKS:
        check(
            f"fallback asserts nothing: {template[:24]}...",
            not claims_a_finding(template.format(eta="about a minute")),
        )

    print("compose always carries the estimate")
    composed = compose("", "about two minutes", 2, "is rack b1 hot")
    check("empty model output -> fallback", "about two minutes" in composed)
    composed = compose("Looking at rack B1", "about two minutes", 2, "is rack b1 hot")
    check("estimate appended when missing", composed.endswith("- about two minutes."))
    composed = compose("On rack B1 - about two minutes.", "about two minutes", 2, "x")
    check("estimate not duplicated", composed.count("about two minutes") == 1)
    composed = compose("Checking rack B1, no alerts yet", "about a minute", 1, "x")
    check("invented finding -> fallback", not claims_a_finding(composed))
    check("fallback still carries estimate", mentions_eta(composed, 1))
    for template in _FALLBACKS:
        check(
            f"fallback carries estimate: {template[:24]}...",
            "about a minute" in template.format(eta="about a minute"),
        )

    print("telegram payload")
    global _post_json
    real_post = _post_json
    try:
        sent: list[dict[str, Any]] = []
        _post_json = lambda url, payload, timeout: sent.append(payload) or {}  # noqa: E731
        _send_blocking("t", "42", "rack B1 <hot> & rising", "7", "forum")
        check("html escaped", sent[-1]["text"] == "<i>rack B1 &lt;hot&gt; &amp; rising</i>")
        check("forum topic carried", sent[-1].get("message_thread_id") == 7)
        _send_blocking("t", "42", "dm", "7", "group")
        check("topic id withheld outside forums", "message_thread_id" not in sent[-1])

        attempts: list[dict[str, Any]] = []

        def _flaky(url: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
            attempts.append(dict(payload))
            if len(attempts) == 1:
                raise urllib.error.HTTPError(url, 400, "Bad Request", None, None)
            return {}

        _post_json = _flaky
        _send_blocking("t", "42", "italics rejected", "", "dm")
        check("400 retries as plain text", attempts[-1] == {"chat_id": "42", "text": "italics rejected"})
    finally:
        _post_json = real_post

    print(f"\n{'FAILED: ' + str(len(failures)) if failures else 'all checks passed'}")
    return 1 if failures else 0


def _try_live(message: str) -> int:
    url, model = _endpoint()
    print(f"endpoint: {url}\nmodel:    {model}")
    state = _read_state()
    durations: list[float] = []
    for entry in state.get("sessions", {}).values():
        if isinstance(entry, dict) and entry.get("durations"):
            durations = entry["durations"]
            break
    phrase, minutes = eta_phrase(estimate_seconds(durations))
    print(f"estimate: {phrase}  (from {durations or 'priors'})")
    started = time.perf_counter()
    try:
        raw = _generate_blocking(message, phrase, _float_env("HERMES_ACK_TIMEOUT_S", _DEFAULT_TIMEOUT_S))
    except Exception as err:
        print(f"model call failed ({err!r}) -- falling back")
        raw = ""
    elapsed = time.perf_counter() - started
    print(f"latency:  {elapsed:.2f}s")
    print(f"receipt:  {compose(raw, phrase, minutes, message)}")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    if "--try" in sys.argv:
        index = sys.argv.index("--try")
        raise SystemExit(_try_live(" ".join(sys.argv[index + 1 :]) or "is rack B1 hot?"))
    print(__doc__)
    print("usage: handler.py --selftest | --try <message>")
