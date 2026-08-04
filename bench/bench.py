"""Per-graph NPU profiling of the Qwen3-4B-Instruct-2507 W4A16 Genie bundle.

Why this exists: BENCHMARK_PLAN.md section 3 wants per-op evidence for the AI Hub
W4A16 bundle on the Hexagon NPU. The bundle is a 4-part Genie LLM export, and
each part*.bin holds 10 graphs (context lengths 512..4096 x {prompt_ar128
prefill, token_ar1 decode}) whose order differs per part.

Method:
  1. Discovery pass -- run qnn-net-run with "__" (skip) in every input-list slot.
     Costs one context load, executes nothing, and emits execution_metadata.yaml
     with the authoritative graph order and every tensor's dims + datatype.
  2. Build zero-filled native-dtype raw inputs for exactly one target graph from
     those dims, and put "__" in the other nine slots.
  3. Run with --profiling_level, --perf_profile burst, N inferences.

Zero inputs are valid for timing: the HTP is fixed-point with no data-dependent
control flow, so latency does not vary with tensor values. Outputs are discarded.

Runtime note: the tool is QAIRT 2.32.6 (qnn-net-run.exe) but the backend libs
are GenieX's QAIRT 2.45 -- the bundle's context blob is version 3.3.4, which
2.32's backend refuses ("Can't read future blob"). Mixing the 2.32 harness with
the 2.45 backend is what makes this profilable at all.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

SDK = r"C:\Qualcomm\AIStack\QAIRT\2.32.6.250402"
NET_RUN = os.path.join(SDK, "bin", "aarch64-windows-msvc", "qnn-net-run.exe")
VIEWER = os.path.join(SDK, "bin", "aarch64-windows-msvc", "qnn-profile-viewer.exe")
GX = os.path.join(os.environ["LOCALAPPDATA"], "GenieX CLI", "qairt", "htp-files")
BUNDLE = os.path.join(
    os.environ["USERPROFILE"], ".cache", "geniex", "models",
    "qualcomm", "Qwen3-4B-Instruct-2507",
)
WORK = os.path.dirname(os.path.abspath(__file__))
PARTS = [f"part{i}_of_4.bin" for i in (1, 2, 3, 4)]


def env():
    e = dict(os.environ)
    e["PATH"] = GX + os.pathsep + e["PATH"]
    e["ADSP_LIBRARY_PATH"] = GX
    return e


def dtype_bytes(dt):
    m = re.search(r"_(\d+)$", dt)
    return int(m.group(1)) // 8 if m else 4


def parse_metadata(path):
    """Minimal parser for qnn-net-run's execution_metadata.yaml."""
    graphs, cur, section, tensor = [], None, None, None
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.rstrip("\n")
            s = line.strip()
            if s.startswith("- graph_name:"):
                cur = {"name": s.split(":", 1)[1].strip(), "inputs": [], "outputs": []}
                graphs.append(cur)
                section = tensor = None
            elif s == "input_tensors:":
                section = "inputs"
            elif s == "output_tensors:":
                section = "outputs"
            elif s.startswith("- tensor_name:") and cur and section:
                tensor = {"name": s.split(":", 1)[1].strip()}
                cur[section].append(tensor)
            elif tensor is not None and s.startswith("datatype:"):
                tensor["dtype"] = s.split(":", 1)[1].strip()
            elif tensor is not None and s.startswith("dimensions:"):
                dims = s.split(":", 1)[1].strip().strip("[]")
                tensor["dims"] = [int(x) for x in dims.split(",") if x.strip()]
    return graphs


def discover(part, nslots=10):
    """One skip-everything run -> authoritative graph order + tensor shapes."""
    out = os.path.join(WORK, "disc", part.replace(".bin", ""))
    yaml = os.path.join(out, "execution_metadata.yaml")
    if os.path.isfile(yaml):
        return parse_metadata(yaml)
    os.makedirs(out, exist_ok=True)
    for _ in range(3):
        cmd = [NET_RUN, "--retrieve_context", os.path.join(BUNDLE, part),
               "--backend", os.path.join(GX, "QnnHtp.dll"),
               "--input_list", ",".join(["__"] * nslots),
               "--output_dir", out]
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env(), cwd=WORK)
        if os.path.isfile(yaml):
            return parse_metadata(yaml)
        m = re.search(r"does not match the number of provided input infos, (\d+) != (\d+)",
                      (proc.stdout or "") + (proc.stderr or ""))
        if not m:
            raise SystemExit(f"discovery failed for {part}:\n{proc.stdout}\n{proc.stderr}")
        nslots = int(m.group(1))
    raise SystemExit(f"discovery did not converge for {part}")


def profile(part, graphs, target, iters, level):
    names = [g["name"] for g in graphs]
    if target not in names:
        return {"part": part, "graph": target, "error": f"not found in {names}"}
    pos = names.index(target)
    spec = graphs[pos]

    stem = f"{part.replace('.bin', '')}_{target}"
    indir = os.path.join(WORK, "gen", stem)
    outdir = os.path.join(WORK, "out", stem)
    shutil.rmtree(outdir, ignore_errors=True)
    os.makedirs(indir, exist_ok=True)

    entries, total = [], 0
    for t in spec["inputs"]:
        n = dtype_bytes(t["dtype"])
        for d in t["dims"]:
            n *= d
        p = os.path.join(indir, t["name"] + ".raw")
        with open(p, "wb") as fh:
            fh.write(b"\x00" * n)
        entries.append(f"{t['name']}:={p}")
        total += n
    lst = os.path.join(indir, "input_list.txt")
    with open(lst, "w", encoding="utf-8") as fh:
        fh.write(" ".join(entries) + "\n")

    slots = ["__"] * len(names)
    slots[pos] = lst
    cmd = [NET_RUN, "--retrieve_context", os.path.join(BUNDLE, part),
           "--backend", os.path.join(GX, "QnnHtp.dll"),
           "--input_list", ",".join(slots),
           "--use_native_input_files",
           "--profiling_level", level,
           "--num_inferences", str(iters),
           "--keep_num_outputs", "1",
           "--output_dir", outdir,
           "--perf_profile", "burst"]

    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env(), cwd=WORK)
    wall = time.time() - t0
    shutil.rmtree(indir, ignore_errors=True)

    log = os.path.join(outdir, "qnn-profiling-data_0.log")
    csv = os.path.join(outdir, "profile.csv")
    viewer_rc = None
    if os.path.isfile(log):
        v = subprocess.run([VIEWER, "--input_log", log, "--output", csv],
                           capture_output=True, text=True, env=env(), cwd=WORK)
        viewer_rc = v.returncode

    return {
        "part": part, "graph": target, "slot": pos,
        "n_inputs": len(spec["inputs"]), "input_bytes": total,
        "iterations": iters, "profiling_level": level,
        "returncode": proc.returncode, "wall_s": round(wall, 2),
        "viewer_rc": viewer_rc,
        "csv": csv if os.path.isfile(csv) else None,
        "log": log if os.path.isfile(log) else None,
        "stdout": proc.stdout, "stderr": proc.stderr,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cl", type=int, default=4096)
    ap.add_argument("--iters", type=int, default=50)
    ap.add_argument("--level", default="detailed")
    ap.add_argument("--parts", default="1,2,3,4")
    ap.add_argument("--phases", default="prompt_ar128,token_ar1")
    ap.add_argument("--json-out", default=os.path.join(WORK, "results.json"))
    args = ap.parse_args()

    results = []
    for p in args.parts.split(","):
        part = f"part{p.strip()}_of_4.bin"
        graphs = discover(part)
        print(f"### {part}: {len(graphs)} graphs -> "
              f"{[g['name'].replace('_' + part.replace('.bin',''), '') for g in graphs]}")
        sys.stdout.flush()
        for phase in args.phases.split(","):
            target = f"{phase.strip()}_cl{args.cl}_{p.strip()}_of_4"
            r = profile(part, graphs, target, args.iters, args.level)
            results.append(r)
            print(f"  {target}: slot={r.get('slot')} rc={r.get('returncode')} "
                  f"inputs={r.get('n_inputs')} ({r.get('input_bytes', 0) / 1048576:.0f} MiB) "
                  f"wall={r.get('wall_s')}s viewer_rc={r.get('viewer_rc')}")
            if r.get("returncode") not in (0, None):
                for line in (r.get("stdout") or "").strip().splitlines()[-4:]:
                    print("     ", line)
            sys.stdout.flush()

    with open(args.json_out, "w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=1)
    print("wrote", args.json_out)


if __name__ == "__main__":
    sys.exit(main())
