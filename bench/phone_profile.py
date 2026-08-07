"""Per-op NPU profiling of the W4A16 bundle on the phone's Hexagon (Snapdragon 8 Elite).

Companion to bench.py, which does the same job on the laptop's X Elite. This one exists
because of a tooling constraint worth writing down:

  QAIRT Visualizer decides which panel to open by looking for an "artifact_type" key in
  the report. The only profiling reader that emits a report the Visualizer's performance
  parser can consume is libQnnJsonProfilingReader, which ships in QAIRT 2.45. The laptop
  has QAIRT 2.32, whose qnn-profile-viewer cannot load the 2.45 reader (it fails silently
  and writes a zero-byte file). The 2.45 SDK we have is the aarch64-android build, so the
  whole capture chain -- qnn-net-run and qnn-profile-viewer -- runs on the phone, where
  tool and reader versions match.

  The optrace / chrometrace readers are NOT an option for this model: both require a
  schematic file that is only emitted when you generate the context binary yourself. This
  is a prebuilt Qualcomm AI Hub Genie bundle loaded via --retrieve_context, so no
  schematic exists and both readers refuse ("No Valid Input Schematics").

Method mirrors bench.py: one discovery run with "__" in every input-list slot to get the
authoritative graph order and tensor shapes, then zero-filled native-dtype inputs for one
target graph. Zero inputs are valid for timing -- the HTP is fixed-point with no
data-dependent control flow.

Prerequisites: adb on PATH (or ADB env var), the bundle and QAIRT 2.45 runtime libs staged
on the device under DEVICE_BASE, and the 2.45 aarch64-android SDK on the host at SDK45.

Usage:
  python phone_profile.py --part 2 --graph prompt_ar128_cl512 --iters 20
  python tag_qnn_profile.py <output.json> --gzip     # so the Visualizer will classify it
"""
import argparse
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench  # noqa: E402  -- reuses parse_metadata / dtype_bytes

ADB = os.environ.get("ADB") or shutil.which("adb") or "adb"
SDK45 = os.environ.get(
    "QAIRT_245",
    os.path.join(os.path.dirname(os.path.dirname(HERE)), "phone-npu-dl",
                 "qairt-sdk", "qairt", "2.45.0.260326"),
)
DEVICE_BASE = os.environ.get("PHONE_QAIRT", "/data/local/tmp/hermes-npu-bench/qairt")
DEVICE_BUNDLE = os.environ.get("PHONE_BUNDLE", "/data/local/tmp/hermes-npu-bench/bundle")
WORK = "/data/local/tmp/ptrace"

ENVP = (f"LD_LIBRARY_PATH={DEVICE_BASE}/lib "
        f"ADSP_LIBRARY_PATH={DEVICE_BASE}/hexagon-v79/unsigned")


def sh(cmd):
    r = subprocess.run([ADB, "shell", cmd], capture_output=True, text=True)
    return (r.stdout or "") + (r.stderr or "")


def push(local, remote):
    r = subprocess.run([ADB, "push", local, remote], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"adb push failed for {local}:\n{r.stderr}")


def pull(remote, local):
    r = subprocess.run([ADB, "pull", remote, local], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"adb pull failed for {remote}:\n{r.stderr}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--part", default="2")
    ap.add_argument("--graph", default="prompt_ar128_cl512")
    ap.add_argument("--iters", type=int, default=20)
    ap.add_argument("--level", default="detailed")
    ap.add_argument("--outdir", default=os.path.join(HERE, "artifacts", "phone-profile"))
    args = ap.parse_args()

    part = f"part{args.part}_of_4.bin"
    target = f"{args.graph}_{args.part}_of_4"
    staging = os.path.join(HERE, ".phone-staging")

    print("[1/6] staging QAIRT 2.45 tools on device", flush=True)
    for tool in ("qnn-net-run", "qnn-profile-viewer"):
        src = os.path.join(SDK45, "bin", "aarch64-android", tool)
        if not os.path.isfile(src):
            raise SystemExit(f"missing {src}; set QAIRT_245 to the 2.45 SDK root")
        push(src, f"{DEVICE_BASE}/bin/{tool}")
        sh(f"chmod 755 {DEVICE_BASE}/bin/{tool}")
    sh(f"rm -rf {WORK}; mkdir -p {WORK}/gen {WORK}/out {WORK}/disc")

    print(f"[2/6] discovery run on {part}", flush=True)
    sh(f"cd {DEVICE_BASE}/bin && {ENVP} ./qnn-net-run "
       f"--retrieve_context {DEVICE_BUNDLE}/{part} "
       f"--backend {DEVICE_BASE}/lib/libQnnHtp.so "
       f"--input_list {','.join(['__'] * 10)} --output_dir {WORK}/disc")

    os.makedirs(staging, exist_ok=True)
    meta = os.path.join(staging, "execution_metadata.yaml")
    pull(f"{WORK}/disc/execution_metadata.yaml", meta)
    graphs = bench.parse_metadata(meta)
    names = [g["name"] for g in graphs]
    print(f"      {len(graphs)} graphs: {names}", flush=True)
    if target not in names:
        raise SystemExit(f"graph {target} not in {names}")
    pos = names.index(target)
    spec = graphs[pos]

    print(f"[3/6] zero inputs for {target} (slot {pos}, {len(spec['inputs'])} tensors)",
          flush=True)
    gendir = os.path.join(staging, "gen")
    shutil.rmtree(gendir, ignore_errors=True)
    os.makedirs(gendir)
    entries, total = [], 0
    for t in spec["inputs"]:
        n = bench.dtype_bytes(t["dtype"])
        for d in t["dims"]:
            n *= d
        with open(os.path.join(gendir, t["name"] + ".raw"), "wb") as fh:
            fh.write(b"\x00" * n)
        entries.append(f"{t['name']}:={WORK}/gen/{t['name']}.raw")
        total += n
    print(f"      {total / 1048576:.1f} MiB, pushing", flush=True)
    push(gendir, f"{WORK}/gen_push")
    sh(f"cp {WORK}/gen_push/*.raw {WORK}/gen/ && rm -rf {WORK}/gen_push")

    lst = os.path.join(staging, "input_list.txt")
    with open(lst, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(" ".join(entries) + "\n")
    push(lst, f"{WORK}/input_list.txt")

    slots = ["__"] * len(names)
    slots[pos] = f"{WORK}/input_list.txt"

    print(f"[4/6] profiling run: {args.iters} inferences, level={args.level}, burst",
          flush=True)
    out = sh(f"cd {DEVICE_BASE}/bin && {ENVP} ./qnn-net-run "
             f"--retrieve_context {DEVICE_BUNDLE}/{part} "
             f"--backend {DEVICE_BASE}/lib/libQnnHtp.so "
             f"--input_list {','.join(slots)} --use_native_input_files "
             f"--profiling_level {args.level} --num_inferences {args.iters} "
             f"--keep_num_outputs 1 --perf_profile burst --output_dir {WORK}/out")
    if "Finished Executing Graphs" not in out:
        print(out.strip()[-800:])
        raise SystemExit("qnn-net-run did not complete")

    print("[5/6] qnn-profile-viewer with libQnnJsonProfilingReader.so", flush=True)
    sh(f"cd {DEVICE_BASE}/bin && {ENVP} ./qnn-profile-viewer "
       f"--reader {DEVICE_BASE}/lib/libQnnJsonProfilingReader.so "
       f"--input_log {WORK}/out/qnn-profiling-data_0.log "
       f"--output {WORK}/qnn-profile.json")

    print("[6/6] pulling report", flush=True)
    os.makedirs(args.outdir, exist_ok=True)
    dst = os.path.join(args.outdir, f"{target}_qnn-profile.json")
    pull(f"{WORK}/qnn-profile.json", dst)
    shutil.rmtree(staging, ignore_errors=True)
    size = os.path.getsize(dst)
    print(f"      {dst}  {size} bytes")
    if not size:
        raise SystemExit("empty report -- check the reader/viewer versions match")
    print("      next: python tag_qnn_profile.py "
          f'"{dst}" --gzip   # add the artifact_type the Visualizer classifies on')
    return 0


if __name__ == "__main__":
    sys.exit(main())
