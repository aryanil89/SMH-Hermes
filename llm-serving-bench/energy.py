#!/usr/bin/env python
"""
Joules-per-query measurement via HWiNFO shared memory (Snapdragon X Elite).

Replicates the arXiv 2606.11257 method (X1E80100: 315 J/query NPU vs 1,251 CPU):
sample system power at ~2 Hz from HWiNFO's shared memory, integrate with the
trapezoidal rule, subtract an idle baseline measured the same way, divide by
query count. There is no NPU power rail on this platform, so energy is
attributed as (system total - idle) during accelerator-bound serving.

Requires: HWiNFO v8.32+ running with "Shared Memory Support" enabled
(Sensors window -> gear icon / Configure Sensors -> enable Shared Memory).
The free version disables shared memory after 12h; restart HWiNFO if so.

Usage:
  python energy.py --list                # show all power sensors (pick one)
  python energy.py --watch 10            # live-print power for 10s (sanity)
  python energy.py --run --base http://127.0.0.1:18181/v1 --label npu
                                         # idle baseline + N queries, J/query
  python energy.py --run --sensor "Total System Power"   # explicit sensor

The --run protocol: 60s idle -> N agent-shaped queries (12,670-token prompt,
105-token completion cap == the measured Hermes request shape from state.db)
-> integrate -> (load_J - idle_W * load_s) / N. Results appended to
energy-results.json; never overwrites.
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import json
import statistics
import struct
import sys
import time
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).parent
SM_NAMES = ("Global\\HWiNFO_SENS_SM2", "HWiNFO_SENS_SM2")
FILE_MAP_READ = 0x0004
READING_POWER = 5  # SENSOR_READING_TYPE: 1=temp 2=volt 3=fan 4=current 5=power

MODEL = "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0"
# Measured Hermes request shape (state.db means): 12,670 in / 105 out.
PARA = (
    "Datacenter thermal management requires continuous monitoring of inlet and "
    "outlet temperatures across every rack, correlation of airflow metrics with "
    "server load, and rapid escalation when thresholds are crossed. "
)


class SharedMem:
    """Read-only view of HWiNFO_SENS_SM2 via OpenFileMapping/MapViewOfFile."""

    def __init__(self):
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenFileMappingW.restype = wt.HANDLE
        k32.MapViewOfFile.restype = ctypes.c_void_p
        self.handle = None
        errors = {}
        for name in SM_NAMES:
            self.handle = k32.OpenFileMappingW(FILE_MAP_READ, False, name)
            if self.handle:
                break
            errors[name] = ctypes.get_last_error()
        if not self.handle:
            # 2 = does not exist (HWiNFO not publishing); 5 = exists but
            # access denied (HWiNFO elevated + restrictive ACL -> run elevated)
            detail = ", ".join(f"{n}: Win32 error {e}" for n, e in errors.items())
            raise OSError(
                "HWiNFO shared memory not found. Is HWiNFO running with "
                f"'Shared Memory Support' enabled? ({detail})")
        self.view = k32.MapViewOfFile(self.handle, FILE_MAP_READ, 0, 0, 0)
        if not self.view:
            raise OSError("MapViewOfFile failed")

    def _read(self, offset: int, size: int) -> bytes:
        return ctypes.string_at(self.view + offset, size)

    def readings(self) -> list[dict]:
        # Header: sig, ver, rev (3xDWORD), poll_time (i64), then 6 DWORDs of
        # section offsets/sizes/counts.
        hdr = self._read(0, 44)
        (sig, _ver, _rev, _poll, s_off, s_size, s_num,
         r_off, r_size, r_num) = struct.unpack("<IIIqIIIIII", hdr)
        if sig not in (0x53695748,):  # 'HWiS'
            raise OSError(f"Bad shared-memory signature: {sig:#x} (HWiNFO gone?)")
        sensors = []
        for i in range(s_num):
            raw = self._read(s_off + i * s_size, s_size)
            name = raw[8:136].split(b"\0")[0].decode("mbcs", "replace")
            user = raw[136:264].split(b"\0")[0].decode("mbcs", "replace")
            sensors.append(user or name)
        out = []
        for i in range(r_num):
            raw = self._read(r_off + i * r_size, r_size)
            rtype, s_idx, _rid = struct.unpack_from("<III", raw, 0)
            label_orig = raw[12:140].split(b"\0")[0].decode("mbcs", "replace")
            label_user = raw[140:268].split(b"\0")[0].decode("mbcs", "replace")
            unit = raw[268:284].split(b"\0")[0].decode("mbcs", "replace")
            value = struct.unpack_from("<d", raw, 284)[0]
            out.append({
                "type": rtype,
                "sensor": sensors[s_idx] if s_idx < len(sensors) else f"#{s_idx}",
                "label": label_user or label_orig,
                "unit": unit,
                "value": value,
            })
        return out

    def power_readings(self) -> list[dict]:
        return [r for r in self.readings() if r["type"] == READING_POWER]


def pick_sensor(sm: SharedMem, wanted: str | None) -> str:
    """Choose the power reading to integrate. Prefer an explicit --sensor,
    else a system/SoC-total-looking rail, else the largest power reading."""
    powers = sm.power_readings()
    if not powers:
        sys.exit("No power-type readings in shared memory. HWiNFO must be "
                 "v8.32+ on ARM64 for Snapdragon power rails.")
    if wanted:
        for r in powers:
            if wanted.lower() in r["label"].lower():
                return r["label"]
        sys.exit(f"--sensor {wanted!r} not found. Run --list to see options.")
    for key in ("total system power", "system power", "soc power",
                "package power", "cpu package"):
        for r in powers:
            if key in r["label"].lower():
                return r["label"]
    return max(powers, key=lambda r: r["value"])["label"]


def sample_power(sm: SharedMem, label: str, stop_flag: dict,
                 hz: float = 2.0) -> list[tuple[float, float]]:
    """(monotonic_seconds, watts) samples until stop_flag['stop']."""
    out = []
    period = 1.0 / hz
    while not stop_flag.get("stop"):
        t = time.monotonic()
        for r in sm.power_readings():
            if r["label"] == label:
                out.append((t, r["value"]))
                break
        time.sleep(max(0.0, period - (time.monotonic() - t)))
    return out


def trapezoid_joules(samples: list[tuple[float, float]]) -> float:
    j = 0.0
    for (t0, w0), (t1, w1) in zip(samples, samples[1:]):
        j += (w0 + w1) / 2.0 * (t1 - t0)
    return j


def mean_watts(samples: list[tuple[float, float]]) -> float:
    return statistics.mean(w for _, w in samples) if samples else 0.0


def timed_sampling(sm: SharedMem, label: str, seconds: float):
    stop: dict = {}
    import threading
    box: dict = {}
    th = threading.Thread(target=lambda: box.setdefault(
        "s", sample_power(sm, label, stop)))
    th.start()
    time.sleep(seconds)
    stop["stop"] = True
    th.join(timeout=10)
    return box.get("s", [])


def parse_hwinfo_csv(path: Path) -> tuple[list[str], list[tuple[float, dict]]]:
    """Parse a (possibly still-growing) HWiNFO sensors CSV log.

    Returns (power_columns, rows) where rows are (epoch_seconds, {col: watts}).
    Handles both delimiter conventions (',' vs ';') and decimal commas
    (European locale), and both d.m.yyyy and m/d/yyyy dates.
    """
    raw = path.read_text(encoding="mbcs", errors="replace").splitlines()
    if not raw:
        raise SystemExit(f"CSV {path} is empty")
    header_line = raw[0].lstrip("﻿")
    delim = ";" if header_line.count(";") > header_line.count(",") else ","
    header = [h.strip().strip('"') for h in header_line.split(delim)]
    power_cols = [h for h in header if "[W]" in h]
    date_i = next((i for i, h in enumerate(header) if h.lower() == "date"), 0)
    time_i = next((i for i, h in enumerate(header) if h.lower() == "time"), 1)

    def to_float(s: str) -> float | None:
        s = s.strip().strip('"')
        try:
            return float(s)
        except ValueError:
            try:
                return float(s.replace(".", "").replace(",", "."))
            except ValueError:
                return None

    def to_epoch(d: str, t: str) -> float | None:
        d, t = d.strip().strip('"'), t.strip().strip('"')
        for datefmt in ("%d.%m.%Y", "%m/%d/%Y", "%Y-%m-%d", "%d/%m/%Y"):
            for timefmt in ("%H:%M:%S.%f", "%H:%M:%S"):
                try:
                    import datetime as _dt
                    return _dt.datetime.strptime(
                        f"{d} {t}", f"{datefmt} {timefmt}").timestamp()
                except ValueError:
                    continue
        return None

    rows = []
    for line in raw[1:]:
        parts = line.split(delim)
        if len(parts) < len(header) - 2:
            continue
        ts = to_epoch(parts[date_i], parts[time_i])
        if ts is None:
            continue
        vals = {}
        for col in power_cols:
            i = header.index(col)
            if i < len(parts):
                v = to_float(parts[i])
                if v is not None:
                    vals[col] = v
        if vals:
            rows.append((ts, vals))
    if not rows:
        raise SystemExit(f"No parseable data rows in {path} yet")
    return power_cols, rows


def csv_window(rows: list[tuple[float, dict]], col: str,
               t0: float, t1: float) -> list[tuple[float, float]]:
    return [(t, v[col]) for t, v in rows if t0 <= t <= t1 and col in v]


def agent_query(base: str, timeout: int = 900, reps: int = 391) -> dict:
    """One agent-shaped request: PARA*reps prompt (~32.2 tok/rep; 391 ≈ the
    12.7K Hermes shape), 105-token cap."""
    nonce = f"[energy run {uuid.uuid4().hex[:12]}] "
    prompt = nonce + PARA * reps + "\nSummarize the core risk in one sentence."
    body = json.dumps({
        "model": MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 105,
    }).encode()
    req = urllib.request.Request(f"{base}/chat/completions", data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.monotonic()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    return {"seconds": time.monotonic() - t0, "usage": data.get("usage", {})}


def run_protocol(base: str, label: str, sensor: str | None, queries: int,
                 idle_s: float, csv_path: Path | None = None,
                 prompt_reps: int = 391) -> None:
    sm = None
    chosen = None
    if csv_path is None:
        sm = SharedMem()
        chosen = pick_sensor(sm, sensor)
        print(f"Integrating sensor: {chosen!r}")
    else:
        print(f"CSV mode: phase timestamps now, integration from {csv_path} after")

    print(f"[1/3] Idle baseline: {idle_s:.0f}s — leave the machine alone...")
    idle_t0 = time.time()
    if sm is not None:
        idle = timed_sampling(sm, chosen, idle_s)
    else:
        time.sleep(idle_s)
        idle = []
    idle_t1 = time.time()

    print(f"[2/3] Load: {queries} agent-shaped queries against {base}")
    import threading
    stop: dict = {}
    box: dict = {}
    th = None
    if sm is not None:
        th = threading.Thread(target=lambda: box.setdefault(
            "s", sample_power(sm, chosen, stop)))
        th.start()
    load_t0 = time.time()
    t_load0 = time.monotonic()
    per_query = []
    load_t1 = load_t0
    for i in range(queries):
        try:
            q = agent_query(base, reps=prompt_reps)
        except Exception as e:
            # Server killed mid-run (this environment kills geniex by image
            # name): keep the completed queries, integrate only their window.
            print(f"      query {i+1}/{queries} FAILED ({e}) — keeping the "
                  f"{len(per_query)} completed queries", flush=True)
            break
        per_query.append(q)
        load_t1 = time.time()
        u = q["usage"]
        print(f"      query {i+1}/{queries}: {q['seconds']:.1f}s "
              f"({u.get('prompt_tokens','?')} in / {u.get('completion_tokens','?')} out)",
              flush=True)
    t_load = load_t1 - load_t0
    if not per_query:
        raise SystemExit("no query completed — nothing to integrate")
    queries = len(per_query)
    stop["stop"] = True
    if th is not None:
        th.join(timeout=10)
    load = box.get("s", [])

    if csv_path is not None:
        print("      waiting 10s for HWiNFO to flush the CSV...")
        time.sleep(10)
        cols, rows = parse_hwinfo_csv(csv_path)
        # pick the column: --sensor substring, else system-total-ish, else
        # the one with the largest idle->load delta (most workload-sensitive)
        if sensor:
            matches = [c for c in cols if sensor.lower() in c.lower()]
            if not matches:
                raise SystemExit(f"--sensor {sensor!r} not in CSV columns: {cols}")
            chosen = matches[0]
        else:
            chosen = None
            for key in ("total system power", "system power", "soc power",
                        "package power", "cpu package"):
                hit = [c for c in cols if key in c.lower()]
                if hit:
                    chosen = hit[0]
                    break
            if chosen is None:
                def delta(c):
                    i_ = mean_watts(csv_window(rows, c, idle_t0, idle_t1))
                    l_ = mean_watts(csv_window(rows, c, load_t0, load_t1))
                    return l_ - i_
                chosen = max(cols, key=delta)
        print(f"      CSV power columns: {cols}")
        print(f"      integrating: {chosen!r}")
        idle = csv_window(rows, chosen, idle_t0, idle_t1)
        load = csv_window(rows, chosen, load_t0, load_t1)
    idle_w = mean_watts(idle)
    print(f"      idle mean: {idle_w:.2f} W ({len(idle)} samples)")

    load_j = trapezoid_joules(load)
    net_j = load_j - idle_w * t_load
    j_per_query = net_j / queries
    load_w = mean_watts(load)
    print(f"[3/3] {label}: load {t_load:.0f}s, mean {load_w:.2f} W "
          f"(idle {idle_w:.2f} W)")
    print(f"      gross {load_j:.0f} J, net {net_j:.0f} J, "
          f"**{j_per_query:.0f} J/query** over {queries} queries")

    out_path = HERE / "energy-results.json"
    prior = json.loads(out_path.read_text()) if out_path.exists() else []
    prior.append({
        "label": label, "base": base, "sensor": chosen, "queries": queries,
        "prompt_reps": prompt_reps,
        "prompt_tokens_each": per_query[0]["usage"].get("prompt_tokens"),
        "source": "csv" if csv_path is not None else "shared-memory",
        "idle_w": round(idle_w, 2), "load_w": round(load_w, 2),
        "load_s": round(t_load, 1), "gross_j": round(load_j),
        "net_j": round(net_j), "j_per_query": round(j_per_query),
        "per_query_s": [round(q["seconds"], 1) for q in per_query],
        "idle_samples": len(idle), "load_samples": len(load),
    })
    out_path.write_text(json.dumps(prior, indent=2), encoding="utf-8")
    print(f"Appended to {out_path}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true", help="list power sensors")
    ap.add_argument("--watch", type=float, metavar="S",
                    help="print chosen sensor live for S seconds")
    ap.add_argument("--run", action="store_true", help="full J/query protocol")
    ap.add_argument("--base", default="http://127.0.0.1:18181/v1")
    ap.add_argument("--label", default="npu", help="row label (npu/cpu/...)")
    ap.add_argument("--sensor", help="substring of the power reading to use")
    ap.add_argument("--queries", type=int, default=5)
    ap.add_argument("--idle", type=float, default=60.0,
                    help="idle-baseline seconds (default 60)")
    ap.add_argument("--csv", type=Path,
                    help="path to a live HWiNFO sensors CSV log; used instead "
                         "of shared memory (ARM64 build does not publish SM)")
    ap.add_argument("--prompt-reps", type=int, default=391,
                    help="PARA repetitions per query (~32.2 tok each; "
                         "391 = 12.7K Hermes shape, 120 = 3.9K bench shape)")
    args = ap.parse_args()

    if args.list:
        sm = SharedMem()
        rows = sm.power_readings()
        if not rows:
            print("No power readings found (need HWiNFO v8.32+ on ARM64).")
        width = max((len(r['sensor']) for r in rows), default=0)
        for r in rows:
            print(f"{r['sensor']:<{width}}  {r['label']:<40} "
                  f"{r['value']:8.2f} {r['unit']}")
        return
    if args.watch:
        sm = SharedMem()
        chosen = pick_sensor(sm, args.sensor)
        print(f"Watching {chosen!r} for {args.watch:.0f}s")
        for t, w in timed_sampling(sm, chosen, args.watch):
            print(f"  {w:.2f} W")
        return
    if args.run:
        run_protocol(args.base, args.label, args.sensor, args.queries,
                     args.idle, args.csv, args.prompt_reps)
        return
    ap.print_help()


if __name__ == "__main__":
    main()
