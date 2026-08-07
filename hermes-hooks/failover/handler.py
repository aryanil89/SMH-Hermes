"""Failover hook: when the laptop's GenieX is down, answer from the phone's NPU.

The gateway's `agent:start` event fires for every inbound Telegram message. This
hook probes GenieX with a single stdlib TCP connect (NEVER an HTTP request --
RUNBOOK "do not probe GenieX over HTTP": an idle server answers in microseconds
but a mid-prefill server queues the probe for minutes). Only a *refused*
connection means down; a timeout or any other socket error is treated as UP,
because a busy-but-alive GenieX must never trigger a false failover.

When GenieX is confirmed down, the user's question is answered by the Samsung
S25 Ultra's Snapdragon 8 Elite NPU over adb: build a ChatML prompt file (LF
only, UTF-8), `adb push` it, run `failover.sh` (a thin wrapper over
genie-t2t-run -- always --prompt_file, never -p: adb's quoting layers shred a
multiline prompt into argv), and parse the `[BEGIN]:...[END]` markers from
stdout. The answer goes to BOTH Telegram and the wall dashboard, loudly labeled
as a degraded one-shot answer with no tools. Failures send an equally honest
failure line -- silence is exactly what this hook exists to replace.

Ordering note: hooks load and fire in sorted() directory order, so "ack" <
"failover" guarantees the canned receipt reaches the user before the failover
answer. The directory name is load-bearing.

An asyncio.Lock serializes phone runs: two concurrent questions must not start
two genie processes on a 12 GB phone. The doomed gateway turn still times out
against the dead GenieX afterwards and dies quietly; that is the documented
behavior this hook is layered on top of, not a bug it introduces.

Env knobs (process env first, then HERMES_HOME/.env):
  HERMES_FAILOVER          kill switch, default on ("0" disarms the hook)
  HERMES_FAILOVER_ADB      adb binary (default: the winget scrcpy adb, else PATH)
  HERMES_FAILOVER_SERIAL   adb serial to pin (default: auto-detect, see
                           _pick_serial -- set this only to overrule it)
  HERMES_FAILOVER_TIMEOUT  phone answer budget in seconds, default 90
  HERMES_FAILOVER_PROBE    probe target "host:port" override (else config.yaml
                           model.base_url, else 127.0.0.1:18181)

CLI:
  python handler.py --selftest      offline checks, exit 0/1 (installer gate)
  python handler.py --probe         one probe: UP -> exit 0, DOWN -> exit 2
  python handler.py --try [words]   real phone round-trip, print-only, no sends
"""
from __future__ import annotations

import asyncio
import html
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

_TRUTHY = {"1", "true", "yes", "on"}

_PHONE_BASE = "/data/local/tmp/hermes-npu-bench"
_PHONE_PROMPT = _PHONE_BASE + "/failover-prompt.txt"
_PHONE_SCRIPT = _PHONE_BASE + "/failover.sh"
_DSP_ARCH = "v79"  # SM8750; the bundle's htp_backend_ext_config.json agrees

_DEFAULT_ADB = (
    Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local")))
    / "Microsoft" / "WinGet" / "Packages"
    / "Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe"
    / "scrcpy-win64-v3.3.2" / "adb.exe"
)

_DEFAULT_TIMEOUT_S = 90.0
_PUSH_TIMEOUT_S = 15.0
# `adb devices` starts the adb server if it is not up, which is the slow case.
_DEVICES_TIMEOUT_S = 10.0
# Windows loopback needs ~2.03s (measured) to surface ECONNREFUSED -- it
# retransmits the SYN before giving up. A shorter timeout turns "refused"
# into "timeout", which this hook deliberately reads as UP, and the failover
# would never engage. Healthy-path cost is unchanged (~1 ms connect).
_PROBE_TIMEOUT_S = 3.0
_SEND_TIMEOUT_S = 6.0
_WALL_TIMEOUT_S = 4.0
# Cleanup runs after we have already given up on an answer, so it must be short
# -- the caller is waiting to report the failure, not to succeed.
_CLEANUP_TIMEOUT_S = 10.0

# Bracketed on purpose, everywhere this pattern is used.
#
# `pkill -f genie-t2t-run` run over `adb shell` matches its OWN `sh -c` wrapper,
# because that wrapper's command line contains the pattern. Verified on device:
# the naive form reports a pid every time, with nothing actually running. So the
# cleanup would kill the shell doing the cleaning and report a phantom hit.
# `genie-t2t-ru[n]` matches a real process's command line and never the literal
# text of our own -- the same idiom as `ps | grep [x]`.
_GENIE_PATTERN = 'genie-t2t-ru[n]'

_MAX_QUESTION_CHARS = 1800  # ctx is 4096 on the phone; leave room to answer
_MAX_ANSWER_CHARS = 3500    # Telegram hard limit is 4096 incl. label

_WALL_URL = "http://127.0.0.1:7788/api/telegram"

_LABEL_HTML = "\U0001F4F1 <b>phone-NPU failover</b> — degraded mode, no tools:\n"
_LABEL_PLAIN = "\U0001F4F1 phone-NPU failover (degraded mode, no tools):\n"

_SYSTEM_PROMPT = (
    "You are Hermes, the ops assistant for a small datacenter demo rack. You are "
    "answering in DEGRADED FAILOVER mode from a phone NPU because the main model "
    "server on the laptop is down. In this mode you have NO tools and NO live "
    "telemetry: you cannot read sensors, logs, or incident state, so never invent "
    "a reading and never claim to have checked anything. Answer from general "
    "knowledge, note the limitation when it matters, and keep it under 120 words."
)


class FailoverError(RuntimeError):
    """An honest, user-showable reason the phone could not answer."""


# --------------------------------------------------------------------------
# env / config plumbing (same shape as the ack hook)

def _hermes_home() -> Path:
    override = os.environ.get("HERMES_HOME")
    if override:
        return Path(override)
    return Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "hermes"


_dotenv_cache: dict | None = None


def _dotenv() -> dict:
    global _dotenv_cache
    if _dotenv_cache is None:
        vals: dict = {}
        try:
            for raw in (_hermes_home() / ".env").read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                vals[key.strip()] = val.strip().strip("'\"")
        except OSError:
            pass
        _dotenv_cache = vals
    return _dotenv_cache


def _env(name: str, default: str = "") -> str:
    val = os.environ.get(name)
    if val is None or val.strip() == "":
        val = _dotenv().get(name)
    if val is None or str(val).strip() == "":
        return default
    return str(val).strip()


def _flag(name: str, default: bool = False) -> bool:
    raw = _env(name)
    if raw == "":
        return default
    return raw.lower() in _TRUTHY


def _float_env(name: str, default: float) -> float:
    raw = _env(name)
    try:
        return float(raw) if raw else float(default)
    except ValueError:
        return float(default)


def _bot_token() -> str:
    return _env("TELEGRAM_BOT_TOKEN")


def _adb() -> str:
    override = _env("HERMES_FAILOVER_ADB")
    if override:
        return override
    if _DEFAULT_ADB.exists():
        return str(_DEFAULT_ADB)
    return "adb"


def _parse_devices(out: str) -> list:
    """Serials from `adb devices` output that are actually usable.

    Only state "device" counts. "offline", "unauthorized" and "no permissions"
    entries are real lines in that output and adb will not run a command
    against them -- an offline emulator-5554 stub appeared on this laptop the
    moment the adb server was restarted, and counting it would make us pin a
    serial that cannot answer.
    """
    serials = []
    for line in out.splitlines()[1:]:          # first line is the banner
        parts = line.split()
        if len(parts) >= 2 and parts[1] == "device":
            serials.append(parts[0])
    return serials


def _pick_serial() -> str:
    """The serial to pin, or "" when there is nothing usable to pin to.

    Why this exists: adb refuses to run at all -- "more than one
    device/emulator", exit 1 -- when a second device is attached, and at the
    venue there IS a second device, because the UNO Q sensor board is an adb
    target too. Unpinned, plugging in the board silently disarms failover and
    reports it as a generic adb push failure.

    **One usable device still gets pinned.** The first version of this returned
    "" there, reasoning that adb's own default must be unambiguous. It is not:
    adb counts EVERY line of `adb devices` when it decides whether the target
    is ambiguous, including `offline` and `unauthorized` ones it will never run
    against. Measured on this laptop 2026-08-07 with the phone the only usable
    device and a stale `emulator-5554 offline` stub beside it -- `adb shell echo
    hi` exits 1 with "more than one device/emulator". That is the demo's
    recovery beat failing because of a dead entry in a list. Pinning the single
    usable serial costs nothing and removes the whole class.

    With several usable devices we pick the one carrying the genie bundle
    rather than guessing by order: that is the definition of "the phone" for
    this hook, it costs one `test -d` per candidate and only when ambiguous,
    and if it does not resolve to exactly one we say so by name instead of
    picking wrong.
    """
    override = _env("HERMES_FAILOVER_SERIAL")
    if override:
        return override
    try:
        rc, out = _run([_adb(), "devices"], timeout=_DEVICES_TIMEOUT_S)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return ""            # let the real call fail with the real reason
    if rc != 0:
        return ""
    serials = _parse_devices(out)
    if not serials:
        # Nothing usable. Let the real call fail with adb's own message, which
        # says "device not found" -- more useful than anything invented here.
        return ""
    if len(serials) == 1:
        return serials[0]
    carrying = []
    for serial in serials:
        try:
            rc, _out = _run(
                [_adb(), "-s", serial, "shell", f"test -d {_PHONE_BASE}/bundle"],
                timeout=_PROBE_TIMEOUT_S,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            continue
        if rc == 0:
            carrying.append(serial)
    if len(carrying) == 1:
        return carrying[0]
    raise FailoverError(
        f"{len(serials)} adb devices attached ({', '.join(serials)}) and "
        f"{len(carrying)} carry the phone bundle -- set HERMES_FAILOVER_SERIAL"
    )


_serial_cache: str | None = None


def _adb_argv() -> list:
    """adb argv prefix with the serial pinned. Resolved once per process."""
    global _serial_cache
    if _serial_cache is None:
        _serial_cache = _pick_serial()
    return [_adb(), "-s", _serial_cache] if _serial_cache else [_adb()]


_probe_cache: tuple | None = None


def _probe_target() -> tuple:
    """(host, port) of GenieX. HERMES_FAILOVER_PROBE > config.yaml > default."""
    global _probe_cache
    if _probe_cache is not None:
        return _probe_cache
    override = _env("HERMES_FAILOVER_PROBE")
    if override and ":" in override:
        host, _, port = override.rpartition(":")
        try:
            _probe_cache = (host or "127.0.0.1", int(port))
            return _probe_cache
        except ValueError:
            pass
    host, port = "127.0.0.1", 18181
    try:
        # plain-text scan, not yaml.load: this file must stay stdlib-only
        for raw in (_hermes_home() / "config.yaml").read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line.startswith("base_url:"):
                parts = urlsplit(line.split(":", 1)[1].strip().strip("'\""))
                if parts.hostname:
                    host = parts.hostname
                    port = parts.port or (443 if parts.scheme == "https" else 18181)
                break
    except OSError:
        pass
    _probe_cache = (host, port)
    return _probe_cache


# --------------------------------------------------------------------------
# down detection

def _geniex_listening(host: str, port: int, timeout: float = _PROBE_TIMEOUT_S) -> bool:
    """TCP connect. Refused => down. Timeout/anything else => treat as UP:
    a wedged or mid-prefill GenieX still owns the port, and a false failover
    is worse than no failover."""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except ConnectionRefusedError:
        return False
    except OSError:
        return True


# --------------------------------------------------------------------------
# phone path

def _build_prompt(message: str) -> str:
    msg = str(message).replace("\r", "").strip()
    if len(msg) > _MAX_QUESTION_CHARS:
        msg = msg[:_MAX_QUESTION_CHARS] + " ..."
    return (
        "<|im_start|>system\n" + _SYSTEM_PROMPT + "<|im_end|>\n"
        "<|im_start|>user\n" + msg + "<|im_end|>\n"
        "<|im_start|>assistant\n"
    )


def _run(argv: list, timeout: float) -> tuple:
    """Subprocess seam (monkeypatched by --selftest). Returns (rc, out+err)."""
    proc = subprocess.run(
        argv, capture_output=True, text=True, encoding="utf-8",
        errors="replace", timeout=timeout,
    )
    return proc.returncode, (proc.stdout or "") + (proc.stderr or "")


def _extract_answer(output: str) -> str:
    idx = output.find("[BEGIN]:")
    if idx < 0:
        return ""
    seg = output[idx + len("[BEGIN]:"):]
    end = seg.find("[END]")
    truncated = end < 0
    if truncated:
        marker = seg.find("\n=== exit_code")
        if marker >= 0:
            seg = seg[:marker]
    else:
        seg = seg[:end]
    text = seg.replace("\r", "").strip()
    if not text:
        return ""
    if truncated:
        text += " ..."
    if len(text) > _MAX_ANSWER_CHARS:
        text = text[:_MAX_ANSWER_CHARS] + " ..."
    return text


def _classify_adb(rc: int, output: str) -> str:
    low = output.lower()
    if "no devices/emulators found" in low or "device not found" in low:
        return "phone not connected over USB"
    if "unauthorized" in low:
        return "phone unauthorized -- accept the USB-debugging prompt on it"
    if "device offline" in low:
        return "phone shows as offline to adb"
    for line in output.splitlines():
        if line.startswith("[FAILOVER-ERROR]"):
            return line[len("[FAILOVER-ERROR]"):].strip()
    return f"genie-t2t-run exited {rc} with no [BEGIN] marker"


def _kill_phone_inference() -> str:
    """Kill an inference this hook has just abandoned. Returns a short reason.

    Measured on this rig (SM8750 over USB adb, 2026-08-07): killing the local
    adb client -- exactly what subprocess.run's timeout does -- also takes
    genie-t2t-run down on the phone, because adbd tears down the shell's
    process group when the client socket closes. Same result when the adb
    SERVER was killed mid-inference. So on the demo path this function
    normally finds nothing and reports "nothing left running", and that is a
    true answer rather than a failed cleanup.

    It is kept because that teardown is adbd's behaviour rather than ours, and
    it does not hold everywhere this code can run: adb over TCP keeps the
    socket -- and the inference -- alive across a network partition until TCP
    gives up, and a genie-t2t-run started by the bench harness was never in
    our process group to begin with. Either one leaves the NPU and the ~344 MB
    resident model held, and the next failover is the demo's recovery beat,
    the one call that must not fail. When there is nothing to clean up the
    cost is a single pkill.

    failover.sh also clears leftovers on the way in, which covers the case where
    this cleanup could not reach the phone. Doing it here as well means the
    phone is left clean even if no further failover is ever attempted.

    Never raises: this runs on a path that is already reporting a failure, and
    an exception here would replace an honest "phone did not answer" with a
    traceback about cleanup.
    """
    try:
        rc, _out = _run(_adb_argv() + ["shell", f'pkill -f "{_GENIE_PATTERN}"'],
                        timeout=_CLEANUP_TIMEOUT_S)
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return "could not reach the phone to clean up"
    # pkill exits 1 when nothing matched -- the ordinary case when the phone
    # finished just after our deadline expired.
    return "abandoned inference killed" if rc == 0 else "nothing left running"


def _phone_answer(message: str, timeout_s: float) -> str:
    """Blocking: prompt file -> adb push -> failover.sh -> parsed answer.
    Raises FailoverError with an honest reason on every failure path."""
    deadline = time.monotonic() + timeout_s
    prompt = _build_prompt(message)
    fd, tmp = tempfile.mkstemp(prefix="hermes-failover-", suffix=".txt")
    try:
        with os.fdopen(fd, "wb") as fh:  # binary write: LF stays LF on Windows
            fh.write(prompt.encode("utf-8"))
        try:
            rc, out = _run(_adb_argv() + ["push", tmp, _PHONE_PROMPT],
                           timeout=_PUSH_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            raise FailoverError("adb push timed out -- phone/USB stalled") from None
        except FileNotFoundError:
            raise FailoverError(f"adb not found at '{_adb()}'") from None
        if rc != 0:
            raise FailoverError(_classify_adb(rc, out))
        remaining = max(5.0, deadline - time.monotonic())
        try:
            rc, out = _run(
                _adb_argv()
                + ["shell", f"sh {_PHONE_SCRIPT} {_PHONE_PROMPT} {_DSP_ARCH}"],
                timeout=remaining,
            )
        except subprocess.TimeoutExpired:
            # Give up on the answer, not on the phone. The detail is worth
            # carrying into the message even though it is usually "nothing left
            # running": that phrase and "abandoned inference killed" are two
            # different diagnoses of the same timeout, and the second one says
            # the phone was still working when we stopped waiting.
            detail = _kill_phone_inference()
            raise FailoverError(
                f"phone did not answer within {int(timeout_s)}s -- {detail}"
            ) from None
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    answer = _extract_answer(out)
    if not answer:
        raise FailoverError(_classify_adb(rc, out))
    return answer


# --------------------------------------------------------------------------
# composing + delivery

def _compose(answer: str) -> tuple:
    """(telegram_html, plain). Plain doubles as the 400-fallback text and the
    wall text."""
    return _LABEL_HTML + html.escape(answer), _LABEL_PLAIN + answer


def _compose_failure(reason: str) -> tuple:
    line = (
        "\U0001F4F1 phone-NPU failover failed — the laptop model server is "
        "down and the phone could not answer: " + reason
    )
    return html.escape(line), line


def _post_json(url: str, payload: dict, timeout: float, headers: dict | None = None):
    data = json.dumps(payload).encode("utf-8")
    hdrs = {"Content-Type": "application/json"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, headers=hdrs, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read()


def _send_blocking(token: str, chat_id, html_text: str, plain_text: str,
                   thread_id, chat_type) -> bool:
    """Telegram sendMessage; HTML first, one plain retry on a 400 (same
    contract the ack hook uses)."""
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": html_text, "parse_mode": "HTML"}
    if chat_type == "forum" and thread_id not in (None, "", 0):
        try:
            payload["message_thread_id"] = int(thread_id)
        except (TypeError, ValueError):
            pass
    try:
        _post_json(url, payload, _SEND_TIMEOUT_S)
        return True
    except urllib.error.HTTPError as err:
        if err.code != 400:
            raise
    _post_json(url, {"chat_id": chat_id, "text": plain_text}, _SEND_TIMEOUT_S)
    return True


def _wall_post(text: str) -> bool:
    """POST to the wall dashboard's existing /api/telegram intake. Header-only
    auth: x-access-secret iff ACCESS_SHARED_SECRET is set (server checks the
    header only when it has a secret). Never raises."""
    headers = {}
    secret = _env("ACCESS_SHARED_SECRET")
    if secret:
        headers["x-access-secret"] = secret
    try:
        _post_json(
            _WALL_URL,
            {"direction": "outbound", "kind": "system", "text": text},
            _WALL_TIMEOUT_S,
            headers,
        )
        return True
    except Exception as err:
        print(f"[hooks:failover] wall post failed (ignored): {err!r}", flush=True)
        return False


# --------------------------------------------------------------------------
# the hook

_LOCK = asyncio.Lock()  # one genie process on the phone at a time


async def _on_start(context: dict) -> None:
    message = str(context.get("message") or "").strip()
    chat_id = context.get("chat_id")
    if not message or chat_id in (None, ""):
        return
    host, port = _probe_target()
    if _geniex_listening(host, port):
        return  # the healthy path: one ~1 ms connect, nothing else
    print(
        f"[hooks:failover] GenieX refused TCP on {host}:{port} -- engaging phone-NPU failover",
        flush=True,
    )
    timeout_s = _float_env("HERMES_FAILOVER_TIMEOUT", _DEFAULT_TIMEOUT_S)
    async with _LOCK:
        started = time.perf_counter()
        try:
            answer = await asyncio.wait_for(
                asyncio.to_thread(_phone_answer, message, timeout_s),
                timeout=timeout_s + 15.0,
            )
        except FailoverError as err:
            print(f"[hooks:failover] phone path failed: {err}", flush=True)
            tg_html, plain = _compose_failure(str(err))
        except Exception as err:
            print(f"[hooks:failover] phone path failed: {err!r}", flush=True)
            tg_html, plain = _compose_failure("unexpected error in the adb path")
        else:
            elapsed = time.perf_counter() - started
            print(
                f"[hooks:failover] phone answered in {elapsed:.1f}s ({len(answer)} chars)",
                flush=True,
            )
            tg_html, plain = _compose(answer)
    token = _bot_token()
    sends = [asyncio.to_thread(_wall_post, plain)]
    if token:
        sends.append(asyncio.to_thread(
            _send_blocking, token, chat_id, tg_html, plain,
            context.get("thread_id"), context.get("chat_type"),
        ))
    else:
        print("[hooks:failover] TELEGRAM_BOT_TOKEN unset -- wall only", flush=True)
    for res in await asyncio.gather(*sends, return_exceptions=True):
        if isinstance(res, Exception):
            print(f"[hooks:failover] delivery failed (ignored): {res!r}", flush=True)


async def handle(event_type: str, context: dict) -> None:
    """Gateway entry point. Must never raise and must never block the loop:
    the phone run happens on a worker thread behind wait_for."""
    try:
        if event_type != "agent:start":
            return
        if not _flag("HERMES_FAILOVER", default=True):
            return
        if not isinstance(context, dict) or context.get("platform") != "telegram":
            return
        await _on_start(context)
    except Exception as err:
        print(f"[hooks:failover] swallowed hook error: {err!r}", flush=True)


# --------------------------------------------------------------------------
# CLI: --selftest / --probe / --try

def _selftest() -> int:  # noqa: C901 - deliberately one long linear script
    mod = sys.modules[__name__]
    failures: list = []
    count = 0

    def check(label: str, ok: bool) -> None:
        nonlocal count
        count += 1
        print(("  ok   " if ok else "  FAIL ") + label)
        if not ok:
            failures.append(label)

    # hermetic env: real .env / config.yaml must not leak into these checks
    global _dotenv_cache, _probe_cache, _serial_cache
    saved_env = {
        k: os.environ.get(k)
        for k in ("HERMES_HOME", "HERMES_FAILOVER", "HERMES_FAILOVER_PROBE",
                  "HERMES_FAILOVER_ADB", "HERMES_FAILOVER_SERIAL",
                  "ACCESS_SHARED_SECRET", "TELEGRAM_BOT_TOKEN")
    }
    tmp_home = tempfile.mkdtemp(prefix="hermes-failover-selftest-")
    os.environ["HERMES_HOME"] = tmp_home
    for key in list(saved_env)[1:]:
        os.environ.pop(key, None)
    _dotenv_cache = None
    _probe_cache = None
    # Pin the serial to "no serial" so _adb_argv() cannot shell out to a real
    # `adb devices` from an offline test, and so the argv checks below stay
    # positional. Serial resolution gets its own checks further down.
    _serial_cache = ""

    real_run, real_post, real_listen = _run, _post_json, _geniex_listening
    try:
        # -- probe semantics on real sockets ------------------------------
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen(1)
        port = srv.getsockname()[1]
        check("probe: listening socket reads as UP", _geniex_listening("127.0.0.1", port) is True)
        srv.close()
        check("probe: refused connect reads as DOWN", _geniex_listening("127.0.0.1", port) is False)
        check("probe: default target is 127.0.0.1:18181 without config",
              _probe_target() == ("127.0.0.1", 18181))
        os.environ["HERMES_FAILOVER_PROBE"] = "127.0.0.1:19999"
        _probe_cache = None
        check("probe: HERMES_FAILOVER_PROBE override wins",
              _probe_target() == ("127.0.0.1", 19999))
        os.environ.pop("HERMES_FAILOVER_PROBE")
        _probe_cache = None

        # -- prompt build --------------------------------------------------
        prompt = _build_prompt("is rack B1 hot?\r\n")
        check("prompt: ChatML skeleton in order",
              prompt.index("<|im_start|>system") < prompt.index("<|im_start|>user")
              < prompt.index("<|im_start|>assistant"))
        check("prompt: ends with open assistant turn", prompt.endswith("<|im_start|>assistant\n"))
        check("prompt: question present, CR stripped",
              "is rack B1 hot?" in prompt and "\r" not in prompt)
        check("prompt: degraded-mode contract in system text",
              "NO tools" in prompt and "FAILOVER" in prompt)
        check("prompt: long question capped",
              len(_build_prompt("x" * 9000)) < 9000)

        # -- answer extraction --------------------------------------------
        fixture = (
            "Using libGenie.so version 1.17.0\n\n[INFO] \"Using create From Binary\"\n"
            "[PROMPT]: ...\n\n[BEGIN]: Rack B1 runs hot when airflow is blocked.[END]\n"
            "=== exit_code 0\n"
        )
        check("extract: happy path",
              _extract_answer(fixture) == "Rack B1 runs hot when airflow is blocked.")
        check("extract: missing [END] -> tail kept + ellipsis",
              _extract_answer("[BEGIN]: partial answer\n=== exit_code 124\n") == "partial answer ...")
        check("extract: no markers -> empty", _extract_answer("garbage\n=== exit_code 1") == "")
        long_out = "[BEGIN]: " + ("y" * 5000) + "[END]"
        check("extract: capped for Telegram",
              len(_extract_answer(long_out)) <= _MAX_ANSWER_CHARS + 4)

        # -- failure classification ----------------------------------------
        check("classify: no device",
              _classify_adb(1, "adb: error: ... no devices/emulators found")
              == "phone not connected over USB")
        check("classify: unauthorized",
              "unauthorized" in _classify_adb(1, "error: device unauthorized."))
        check("classify: [FAILOVER-ERROR] line surfaces verbatim",
              _classify_adb(3, "[FAILOVER-ERROR] bundle missing at /data/local/tmp/x\n")
              == "bundle missing at /data/local/tmp/x")
        check("classify: fallback names the exit code",
              _classify_adb(9, "???") == "genie-t2t-run exited 9 with no [BEGIN] marker")

        # -- adb orchestration (monkeypatched _run) -------------------------
        calls: list = []
        pushed: dict = {}

        def fake_run_ok(argv, timeout):
            calls.append(argv)
            if argv[1] == "push":
                pushed["path"] = argv[2]
                pushed["content"] = Path(argv[2]).read_bytes()
                return 0, "1 file pushed"
            return 0, "noise\n[BEGIN]: hi from the phone[END]\n=== exit_code 0\n"

        mod._run = fake_run_ok
        answer = _phone_answer("ping?", 30.0)
        check("adb: happy path returns parsed answer", answer == "hi from the phone")
        check("adb: push then shell, adb argv[0]",
              len(calls) == 2 and calls[0][1] == "push" and calls[1][1] == "shell"
              and calls[1][2] == f"sh {_PHONE_SCRIPT} {_PHONE_PROMPT} {_DSP_ARCH}")
        check("adb: prompt file was LF-only UTF-8 ChatML",
              b"<|im_start|>assistant\n" in pushed["content"] and b"\r" not in pushed["content"])
        check("adb: temp prompt file cleaned up", not Path(pushed["path"]).exists())

        def fake_run_nodev(argv, timeout):
            return 1, "adb: error: failed to get feature set: no devices/emulators found"

        mod._run = fake_run_nodev
        try:
            _phone_answer("q", 30.0)
            check("adb: no-device raises FailoverError", False)
        except FailoverError as err:
            check("adb: no-device raises FailoverError", "not connected" in str(err))

        def fake_run_timeout(argv, timeout):
            if argv[1] == "push":
                return 0, "ok"
            raise subprocess.TimeoutExpired(cmd="adb", timeout=timeout)

        mod._run = fake_run_timeout
        try:
            _phone_answer("q", 30.0)
            check("adb: shell timeout raises FailoverError", False)
        except FailoverError as err:
            check("adb: shell timeout raises FailoverError", "within 30s" in str(err))

        # A timeout kills the local adb client; the phone-side genie-t2t-run
        # survives it, holding the NPU. Prove we go back and clear it, and that
        # we say which of the three outcomes happened.
        cleanup_calls: list = []

        def fake_run_timeout_cleanup(argv, timeout):
            joined = " ".join(argv)
            if argv[1] == "push":
                return 0, "ok"
            if "pkill" in joined:
                cleanup_calls.append(joined)
                return 0, ""
            raise subprocess.TimeoutExpired(cmd="adb", timeout=timeout)

        mod._run = fake_run_timeout_cleanup
        try:
            _phone_answer("q", 30.0)
            check("timeout: still raises after cleanup", False)
        except FailoverError as err:
            check("timeout: kills the abandoned phone inference", len(cleanup_calls) == 1)
            check("timeout: reports the cleanup outcome",
                  "abandoned inference killed" in str(err))
        # The bracket is the whole point: `pkill -f genie-t2t-run` over adb
        # matches its own `sh -c` wrapper (verified on device -- the naive form
        # returns a pid with nothing running), so the cleanup would kill the
        # shell doing the cleaning and report a phantom success. Pinned here so
        # a tidy-up edit cannot quietly drop it.
        check("timeout: cleanup pattern cannot self-match",
              bool(cleanup_calls)
              and "genie-t2t-ru[n]" in cleanup_calls[0]
              and "genie-t2t-run" not in cleanup_calls[0])

        # Cleanup that cannot reach the phone must degrade, not mask the real
        # failure with a traceback about cleanup.
        def fake_run_all_timeout(argv, timeout):
            if argv[1] == "push":
                return 0, "ok"
            raise subprocess.TimeoutExpired(cmd="adb", timeout=timeout)

        mod._run = fake_run_all_timeout
        try:
            _phone_answer("q", 30.0)
            check("timeout: unreachable phone still raises the real reason", False)
        except FailoverError as err:
            check("timeout: unreachable phone still raises the real reason",
                  "within 30s" in str(err) and "could not reach the phone" in str(err))

        def fake_run_scripterr(argv, timeout):
            if argv[1] == "push":
                return 0, "ok"
            return 3, "[FAILOVER-ERROR] bundle missing at /data/local/tmp/hermes-npu-bench/bundle\n"

        mod._run = fake_run_scripterr
        try:
            _phone_answer("q", 30.0)
            check("adb: script error surfaces reason", False)
        except FailoverError as err:
            check("adb: script error surfaces reason", "bundle missing" in str(err))
        mod._run = real_run

        # -- compose ---------------------------------------------------------
        tg, plain = _compose("a<b & c")
        check("compose: label + HTML escape",
              tg.startswith(_LABEL_HTML) and "a&lt;b &amp; c" in tg)
        check("compose: plain keeps raw text", plain == _LABEL_PLAIN + "a<b & c")
        ftg, fplain = _compose_failure("phone not connected over USB")
        check("compose: failure line is honest and labeled",
              "failover failed" in fplain and "phone not connected" in fplain)

        # -- telegram payload (monkeypatched _post_json) ----------------------
        posts: list = []

        def fake_post(url, payload, timeout, headers=None):
            posts.append((url, payload, headers))
            return 200, b"{}"

        mod._post_json = fake_post
        _send_blocking("TOK", "42", "<b>x</b>", "plain x", "7", "forum")
        check("telegram: HTML payload with forum thread id",
              posts[-1][1] == {"chat_id": "42", "text": "<b>x</b>", "parse_mode": "HTML",
                               "message_thread_id": 7})
        _send_blocking("TOK", "42", "<b>x</b>", "plain x", "7", "group")
        check("telegram: non-forum omits thread id",
              "message_thread_id" not in posts[-1][1])

        flaky: list = []

        def fake_post_400(url, payload, timeout, headers=None):
            flaky.append(payload)
            if len(flaky) == 1:
                raise urllib.error.HTTPError(url, 400, "Bad Request", None, None)
            return 200, b"{}"

        mod._post_json = fake_post_400
        _send_blocking("TOK", "42", "<b>x</b>", "plain x", None, "private")
        check("telegram: 400 -> plain retry, no parse_mode",
              flaky[1] == {"chat_id": "42", "text": "plain x"})

        # -- wall payload -----------------------------------------------------
        posts.clear()
        mod._post_json = fake_post
        _wall_post("wall text")
        url, payload, headers = posts[-1]
        check("wall: endpoint + payload shape",
              url == _WALL_URL
              and payload == {"direction": "outbound", "kind": "system", "text": "wall text"})
        check("wall: no secret -> no auth header", not headers)
        os.environ["ACCESS_SHARED_SECRET"] = "s3cret"
        _wall_post("wall text")
        check("wall: secret -> x-access-secret header only",
              posts[-1][2] == {"x-access-secret": "s3cret"})
        os.environ.pop("ACCESS_SHARED_SECRET")

        def fake_post_boom(url, payload, timeout, headers=None):
            raise OSError("wall is down")

        mod._post_json = fake_post_boom
        check("wall: failure swallowed, returns False", _wall_post("x") is False)
        mod._post_json = real_post

        # -- gating through handle() -----------------------------------------
        def probe_must_not_run(host, port, timeout=_PROBE_TIMEOUT_S):
            raise AssertionError("probe ran despite gate")

        ctx = {"platform": "telegram", "chat_id": "42", "message": "q",
               "thread_id": None, "chat_type": "private"}

        os.environ["HERMES_FAILOVER"] = "0"
        mod._geniex_listening = probe_must_not_run
        asyncio.run(handle("agent:start", ctx))
        check("gate: HERMES_FAILOVER=0 disarms", True)
        os.environ.pop("HERMES_FAILOVER")

        asyncio.run(handle("agent:start", {**ctx, "platform": "cli"}))
        check("gate: non-telegram platform skipped", True)
        asyncio.run(handle("agent:end", ctx))
        check("gate: wrong event skipped", True)

        def run_must_not_run(argv, timeout):
            raise AssertionError("adb ran while GenieX was up")

        mod._geniex_listening = lambda h, p, timeout=_PROBE_TIMEOUT_S: True
        mod._run = run_must_not_run
        asyncio.run(handle("agent:start", ctx))
        check("gate: GenieX up -> no phone run", True)

        # -- full offline pass through handle() -------------------------------
        posts.clear()
        mod._geniex_listening = lambda h, p, timeout=_PROBE_TIMEOUT_S: False
        mod._run = fake_run_ok
        mod._post_json = fake_post
        os.environ["TELEGRAM_BOT_TOKEN"] = "TESTTOKEN"
        asyncio.run(handle("agent:start", {**ctx, "message": "is rack B1 hot?"}))
        wall_calls = [p for p in posts if p[0] == _WALL_URL]
        tg_calls = [p for p in posts if "TESTTOKEN" in p[0]]
        check("e2e: wall got the labeled plain answer",
              len(wall_calls) == 1
              and wall_calls[0][1]["text"] == _LABEL_PLAIN + "hi from the phone"
              and wall_calls[0][1]["kind"] == "system")
        check("e2e: telegram got the labeled HTML answer",
              len(tg_calls) == 1
              and tg_calls[0][1]["text"] == _LABEL_HTML + "hi from the phone"
              and tg_calls[0][1]["parse_mode"] == "HTML")
        os.environ.pop("TELEGRAM_BOT_TOKEN")

        # -- serial pinning: the venue has TWO adb devices ------------------
        # The UNO Q sensor board is an adb target as well as the phone. adb
        # exits 1 with "more than one device/emulator" rather than choosing,
        # so unpinned this hook stops working the moment the board is plugged
        # in -- and reports it as an ordinary push failure.
        two_devices = (
            "List of devices attached\n"
            "R3CXC07ZXZB\tdevice\n"
            "0123456789ABCDEF\tdevice\n"
        )
        check("serial: parses only usable devices",
              _parse_devices(two_devices) == ["R3CXC07ZXZB", "0123456789ABCDEF"])
        check("serial: offline/unauthorized entries are not candidates",
              _parse_devices("List of devices attached\n"
                             "emulator-5554\toffline\n"
                             "R3CXC07ZXZB\tdevice\n"
                             "99999\tunauthorized\n") == ["R3CXC07ZXZB"])

        def fake_run_devices(argv, timeout):
            joined = " ".join(argv)
            if argv[1] == "devices":
                return 0, two_devices
            if "test -d" in joined:
                # only the phone carries the bundle
                return (0, "") if "R3CXC07ZXZB" in joined else (1, "")
            return 0, ""

        mod._run = fake_run_devices
        _serial_cache = None
        check("serial: two devices -> picks the one carrying the bundle",
              _pick_serial() == "R3CXC07ZXZB")
        _serial_cache = None
        check("serial: pinned serial reaches the adb argv",
              _adb_argv()[1:3] == ["-s", "R3CXC07ZXZB"])

        def fake_run_one_device(argv, timeout):
            if argv[1] == "devices":
                return 0, "List of devices attached\nR3CXC07ZXZB\tdevice\n"
            raise AssertionError("must not probe when only one device is usable")

        mod._run = fake_run_one_device
        _serial_cache = None
        check("serial: single device is pinned without any probing",
              _pick_serial() == "R3CXC07ZXZB")
        _serial_cache = None
        check("serial: single device still reaches adb as -s",
              _adb_argv() == [_adb(), "-s", "R3CXC07ZXZB"])

        # The regression this replaced: one usable device is NOT the same as an
        # unambiguous adb target. adb counts offline/unauthorized lines too when
        # it decides, so returning "" here exits 1 with "more than one
        # device/emulator" -- measured live on this laptop 2026-08-07 with a
        # stale emulator-5554 stub next to the phone.
        def fake_run_one_plus_offline(argv, timeout):
            if argv[1] == "devices":
                return 0, ("List of devices attached\n"
                           "R3CXC07ZXZB\tdevice\n"
                           "emulator-5554\toffline\n")
            raise AssertionError("must not probe when only one device is usable")

        mod._run = fake_run_one_plus_offline
        _serial_cache = None
        check("serial: one usable device beside an offline stub is still pinned",
              _pick_serial() == "R3CXC07ZXZB")

        def fake_run_no_devices(argv, timeout):
            if argv[1] == "devices":
                return 0, "List of devices attached\n"
            raise AssertionError("must not probe when nothing is attached")

        mod._run = fake_run_no_devices
        _serial_cache = None
        check("serial: nothing attached -> no -s, adb reports its own reason",
              _pick_serial() == "" and _adb_argv() == [_adb()])

        def fake_run_ambiguous(argv, timeout):
            if argv[1] == "devices":
                return 0, two_devices
            return 0, ""          # BOTH claim the bundle -- genuinely ambiguous

        mod._run = fake_run_ambiguous
        _serial_cache = None
        try:
            _pick_serial()
            check("serial: ambiguous devices name themselves in the error", False)
        except FailoverError as err:
            text = str(err)
            check("serial: ambiguous devices name themselves in the error",
                  "R3CXC07ZXZB" in text and "0123456789ABCDEF" in text
                  and "HERMES_FAILOVER_SERIAL" in text)

        os.environ["HERMES_FAILOVER_SERIAL"] = "OVERRIDE1"

        def run_must_not_list(argv, timeout):
            raise AssertionError("override must short-circuit `adb devices`")

        mod._run = run_must_not_list
        _serial_cache = None
        check("serial: explicit override wins without asking adb",
              _pick_serial() == "OVERRIDE1")
        os.environ.pop("HERMES_FAILOVER_SERIAL")
        _serial_cache = ""

        # failure path also delivers (no token -> wall only)
        posts.clear()
        mod._run = fake_run_nodev
        asyncio.run(handle("agent:start", ctx))
        check("e2e: phone failure still posts honest line to wall",
              len(posts) == 1 and posts[0][0] == _WALL_URL
              and "failover failed" in posts[0][1]["text"]
              and "not connected" in posts[0][1]["text"])
    except Exception as err:  # a crashed block is a failed selftest, loudly
        import traceback
        traceback.print_exc()
        failures.append(f"selftest crashed: {err!r}")
    finally:
        mod._run = real_run
        mod._post_json = real_post
        mod._geniex_listening = real_listen
        for key, val in saved_env.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val
        _dotenv_cache = None
        _probe_cache = None
        _serial_cache = None

    status = "PASS" if not failures else "FAIL"
    print(f"[selftest] {status} ({count} checks, {len(failures)} failures)")
    return 0 if not failures else 1


def _probe_cli() -> int:
    host, port = _probe_target()
    up = _geniex_listening(host, port)
    state = ("UP (listening -- failover stays dormant)" if up
             else "DOWN (connection refused -- failover would engage)")
    print(f"GenieX {host}:{port} -> {state}")
    return 0 if up else 2


def _try_cli(question: str) -> int:
    host, port = _probe_target()
    up = _geniex_listening(host, port)
    print(f"[try] probe {host}:{port}: {'UP' if up else 'DOWN'} (ignored -- running the phone path anyway)")
    print(f"[try] adb: {_adb()}")
    timeout_s = _float_env("HERMES_FAILOVER_TIMEOUT", _DEFAULT_TIMEOUT_S)
    started = time.perf_counter()
    try:
        answer = _phone_answer(question, timeout_s)
    except FailoverError as err:
        print(f"[try] FAILED after {time.perf_counter() - started:.1f}s: {err}")
        return 1
    print(f"[try] answered in {time.perf_counter() - started:.1f}s ({len(answer)} chars); no messages sent")
    print()
    print(_LABEL_PLAIN + answer)
    return 0


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(errors="replace")
    except Exception:
        pass
    if "--selftest" in sys.argv:
        raise SystemExit(_selftest())
    if "--probe" in sys.argv:
        raise SystemExit(_probe_cli())
    if "--try" in sys.argv:
        idx = sys.argv.index("--try")
        q = " ".join(sys.argv[idx + 1:]).strip() or "Say hello from the failover brain."
        raise SystemExit(_try_cli(q))
    print(__doc__)
