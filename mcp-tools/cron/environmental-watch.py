#!/usr/bin/env python3
"""Environmental watchdog -- the `--no-agent --script` target for Hermes cron.

Runs the edge-triggered environmental check and prints a message ONLY when an
alert or recovery is warranted. Empty stdout => Hermes delivers nothing, so the
5-minute cadence costs zero LLM tokens per tick and cannot spam the on-call
phone. All alert/cooldown/recovery decisions stay in check-environmental.js.

INSTALL: copy to %LOCALAPPDATA%\\hermes\\scripts\\environmental-watch.py (Hermes
refuses scripts outside HERMES_HOME/scripts), then:
    hermes cron edit <job_id> --script environmental-watch.py --no-agent

WHY PYTHON AND NOT THE ORIGINAL .sh -- do not "simplify" this back to bash.
Hermes chooses a script interpreter purely by file extension
(hermes-agent/cron/scheduler.py): `.sh`/`.bash` are run with
shutil.which("bash"), anything else with Hermes' own Python. On this Windows
ARM64 box `bash` resolves only to WSL launchers --
C:\\Windows\\system32\\bash.exe and the WindowsApps alias -- and the default WSL
distro is docker-desktop, which has no /bin/bash. So every scheduled tick died:

    WSL (9 - Relay) ERROR: CreateProcessCommon:640: execvpe(/bin/bash) failed:
    No such file or directory

A manual `hermes cron run` *appeared* to work because it inherited a shell PATH
that happened to include Git Bash; the long-lived gateway process that fires
scheduled ticks does not. Python is always present, so this cannot regress that
way.

EXIT CODES
  0 -- check completed (whether or not it alerted)
  1 -- infrastructure failure (node or the check script missing/crashed).
       Deliberately loud, so Hermes reports it: a watchdog that fails silently
       is worse than one that nags, and silent failure is exactly how the WSL
       bug survived a whole evening.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

# The only machine-specific line. Override with SMH_HERMES_ROOT rather than
# editing this if you can, since the installed copy lives outside the repo.
REPO_ROOT = Path(
    os.environ.get("SMH_HERMES_ROOT", r"C:\Users\qc_de\Downloads\QUAD\SMH-Hermes")
)
CHECK_JS = Path(
    os.environ.get(
        "UNOQ_CHECK_SCRIPT",
        REPO_ROOT / "mcp-tools" / "dist" / "alert-skill" / "check-environmental.js",
    )
)
NODE_FALLBACKS = (r"C:\Program Files\nodejs\node.exe",)
TIMEOUT_S = 120


def fail(msg: str) -> int:
    print(f"[environmental-watch] {msg}", file=sys.stderr)
    return 1


def main() -> int:
    node = shutil.which("node") or next(
        (p for p in NODE_FALLBACKS if os.path.isfile(p)), None
    )
    if node is None:
        return fail("node not found on PATH and no known fallback exists")
    if not CHECK_JS.is_file():
        return fail(f"check script missing: {CHECK_JS} (build mcp-tools first?)")

    env = dict(os.environ)
    # Keep in sync with the environmental server's env block in config.yaml --
    # a cron script does NOT inherit it. Board ticks ~every 10s; >3 min = stale,
    # and a stale log makes the reading fall back to mock with a reason chain.
    env.setdefault("UNOQ_LOG_MAX_AGE_S", "180")
    # Water-level leak threshold (mm) -- uncomment and calibrate against the
    # empty tray after the bench test. Left off so behaviour matches the
    # event-based leak trigger currently used on stage.
    # env.setdefault("UNOQ_LEAK_DISTANCE_MM", "150")

    try:
        proc = subprocess.run(
            [node, str(CHECK_JS)],
            capture_output=True,
            text=True,
            timeout=TIMEOUT_S,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return fail(f"check timed out after {TIMEOUT_S}s")
    except OSError as exc:
        return fail(f"could not launch node: {exc}")

    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().replace("\n", " ")
        return fail(f"check exited {proc.returncode}: {detail[:500]}")

    out = (proc.stdout or "").strip()
    if out.startswith("ALERT"):
        # Drop the "ALERT <status>" contract line; deliver just the message text.
        message = "\n".join(out.splitlines()[1:]).strip()
        if message:
            print(message)
    # NO_ALERT (or empty) -> print nothing, Hermes stays silent.
    return 0


if __name__ == "__main__":
    sys.exit(main())
