#!/usr/bin/env python3
"""Trim the board's sensor log: drop malformed lines and anything older than the
retention window.

Runs on the Uno Q's Linux host, called hourly from push_sensor_log.sh. Not a
Hermes cron job and deliberately not an agent: "is this timestamp older than 24
hours" is arithmetic, and spending a two-minute local-model completion on it
every hour would be the same mistake the rule evaluator exists to avoid.

WHY IT MATTERS -- and it is not disk space. The log grows ~0.3 MB/day, which
this board would not notice for a year. But push_sensor_log.sh scp's the WHOLE
file to the laptop every 10 seconds, so a 0.5 MB log costs ~169 MB/hour over
Tailscale and that number climbs forever. Capping the file caps the transport.

RETENTION IS MEASURED FROM THE NEWEST LOG LINE, NOT THE WALL CLOCK.
The board has no RTC battery and boots at 1970 until NTP lands (see the boot
stage display in python/main.py). Pruning against `now` during that window would
compute a cutoff in 1969, decide every real reading is from the future, and --
depending which way the comparison fell -- either do nothing or delete the
entire sensor history the alert baselines are built from. Comparing lines to the
newest line is self-consistent under any clock, which is the same reason the
rule evaluator watermarks on log timestamps instead of tick time.

Exit code is 0 for every outcome the loop should survive (nothing to do, clock
nonsense, unreadable file). A pruner that kills the push loop is worse than one
that skips an hour.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta

LOG_PATH = os.environ.get(
    "UNOQ_BOARD_LOG", "/home/arduino/ArduinoApps/hermes-sensor-logger/sensor_log.jsonl"
)
RETENTION_HOURS = float(os.environ.get("UNOQ_LOG_RETENTION_H", "24"))

# Refuse to leave the log this short. A prune that empties the file destroys the
# observed history every alert rule is validated against ("temperature here has
# stayed between 22.2 and 35.7 over 31h"), and the board cannot get it back.
# If the arithmetic ever says "keep almost nothing", the arithmetic is wrong.
MIN_KEEP_LINES = 10


def parse(line: str) -> datetime | None:
    """Timestamp of a line that the laptop side would actually accept.

    Mirrors parseSensorLogLine() in mcp-tools/src/environmental/file-source.ts:
    a line missing `event` or the numeric fields is dropped there silently, so
    keeping it here only pays transport for something nothing will ever read.
    """
    try:
        obj = json.loads(line)
        if not isinstance(obj.get("event"), str):
            return None
        if not isinstance(obj.get("temperature_c"), (int, float)):
            return None
        if not isinstance(obj.get("humidity_pct"), (int, float)):
            return None
        return datetime.fromisoformat(obj["timestamp"])
    except (ValueError, TypeError, AttributeError, KeyError):
        # Unparseable JSON, a truncated trailing line from a write in flight, or
        # a timestamp in some other format. All of it is unreadable downstream.
        return None


def main() -> int:
    try:
        with open(LOG_PATH, "r", encoding="utf-8") as f:
            raw_lines = f.read().splitlines()
    except OSError as exc:
        print(f"prune: cannot read {LOG_PATH}: {exc}", file=sys.stderr)
        return 0

    parsed: list[tuple[str, datetime]] = []
    dropped_bad = 0
    for line in raw_lines:
        if not line.strip():
            continue
        ts = parse(line)
        if ts is None:
            dropped_bad += 1
        else:
            parsed.append((line, ts))

    if not parsed:
        print("prune: no parseable lines, leaving file untouched", file=sys.stderr)
        return 0

    newest = max(ts for _, ts in parsed)
    cutoff = newest - timedelta(hours=RETENTION_HOURS)
    keep = [line for line, ts in parsed if ts >= cutoff]
    dropped_old = len(parsed) - len(keep)

    if dropped_bad == 0 and dropped_old == 0:
        return 0  # nothing to do; do not rewrite the file for free

    if len(keep) < MIN_KEEP_LINES:
        print(
            f"prune: refusing to cut {len(parsed)} lines down to {len(keep)} "
            f"(retention={RETENTION_HOURS}h, newest={newest.isoformat()}) -- "
            "this looks like a clock problem, not a full log",
            file=sys.stderr,
        )
        return 0

    # Same-directory temp + atomic replace. The App Lab container appends by
    # reopening the path for each line, so the worst case is a single
    # sensor_tick landing in the replaced inode and being lost. One tick out of
    # 8,640 a day is not worth a lock the container does not participate in.
    directory = os.path.dirname(LOG_PATH) or "."
    # mkstemp creates 0600 and os.replace keeps the *replacement's* mode, so
    # without this the log silently becomes owner-only. It happens to still
    # work (the App Lab container appends as the same user), which is exactly
    # what makes it worth fixing now rather than discovering later.
    try:
        original_mode = os.stat(LOG_PATH).st_mode & 0o777
    except OSError:
        original_mode = 0o644
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".sensor_log.", suffix=".prune")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as out:
            out.write("\n".join(keep) + "\n")
            out.flush()
            os.fsync(out.fileno())
        os.chmod(tmp, original_mode)
        os.replace(tmp, LOG_PATH)
    except OSError as exc:
        print(f"prune: write failed: {exc}", file=sys.stderr)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return 0

    print(
        f"prune: kept {len(keep)}, dropped {dropped_old} older than "
        f"{RETENTION_HOURS}h and {dropped_bad} malformed"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
