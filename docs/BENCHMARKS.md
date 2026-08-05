# Benchmarks — W4A16 NPU bundle, per-op and per-phase

Results for [BENCHMARK_PLAN.md](BENCHMARK_PLAN.md) **§3 (per-op evidence on the NPU bundle)**,
measured live on the target laptop 2026-08-03. §1 (throughput of the *served* GGUF artifact) and
§2 (Joules/query) are separate runs and are not in this file yet.

## Honest labeling — read this before quoting any number here

**The artifact profiled here is not the artifact the agent runs on.** Same weights, two builds:

| | Profiled here | Served to Hermes |
|---|---|---|
| Artifact | `qualcomm/Qwen3-4B-Instruct-2507:W4A16` (AI Hub Genie bundle, 3.0 GiB) | `unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0` (2.21 GiB on disk) |
| Runtime | QAIRT/Genie context binaries via `qnn-net-run` on Hexagon | GenieX `llama.cpp` Hexagon backend |
| Context | **fixed** 512 / 1024 / 2048 / 3072 / 4096 | 65536 |
| Tool calls | not parsed | yes |

So the numbers below characterize **this model's graphs on the Hexagon NPU**. They are *not* the
throughput of the demoed system — see [ARCHITECTURE.md §4](ARCHITECTURE.md#4-one-model-two-artifacts)
and [NPU_SPIKE_RESULTS.md](NPU_SPIKE_RESULTS.md) for the served path.

## Environment

| Component | Value |
|---|---|
| Device | Snapdragon X Elite X1E80100, Hexagon **v73**, soc_model 60, 31.6 GB RAM, Windows 11 ARM64 |
| Harness | `qnn-net-run.exe` / `qnn-profile-viewer.exe` from **QAIRT 2.32.6.250402** (`aarch64-windows-msvc`) |
| Backend libs | **QAIRT 2.45.0.260326**, from GenieX's `%LOCALAPPDATA%\GenieX CLI\qairt\htp-files` |
| Perf profile | `burst`, 4 HVX threads (as reported by the backend) |
| Reps | **50 inferences per graph**; cold (first) inference reported separately, never averaged in |

**The version mix is required, not incidental.** The bundle's context blob is version **3.3.4**;
the 2.32.6 backend refuses it outright:

```
<E> Can't read future blob. Newest blob version supported: 3.2.2. Current blob version: 3.3.4.
<E> Failed to create context from binary with err 0x7531
```

Pointing `--backend` at GenieX's 2.45 `QnnHtp.dll` (with `htp-files` first on `PATH` and as
`ADSP_LIBRARY_PATH`) is what makes the bundle profilable at all. A native ARM64 QAIRT ≥ 2.45 SDK
would remove the need for the mix.

## Method

Each `part*.bin` holds **10 graphs** — the 5 context lengths × {`prompt_ar128` prefill,
`token_ar1` decode} — in a **different order per part**. `metadata.json` documents only one
representative graph per part, so shapes and order were taken from the runtime instead:

1. **Discovery pass** — run with `__` (the documented skip token) in all 10 input-list slots. This
   loads the context, executes nothing, and writes `execution_metadata.yaml` containing the
   authoritative graph order plus every tensor's dims and datatype.
2. **Single-graph runs** — generate zero-filled native-dtype `.raw` inputs for exactly one target
   graph from those dims, and put `__` in the other nine slots.
3. Timing at `--profiling_level basic`; per-op cycles at `detailed` (see the overhead caveat below).

Zero inputs are valid for timing: the HTP is fixed-point with no data-dependent control flow, so
latency does not vary with tensor values. Outputs are discarded.

**Is this measuring compute or host transfer?** Compute. For `token_ar1_cl4096` part2, of 68.81 ms
total graph time, `Accelerator (execute) time` is **63.67 ms — 92.5%**; RPC 64.80 ms, accelerator
excluding wait 63.45 ms. qnn-net-run reuses the uploaded tensors across the 50 inferences, so the
~96 MiB of KV-cache input is not re-marshalled per inference. These are steady-state Hexagon
numbers.

Harness: [`bench/bench.py`](../bench/bench.py) (discovery + runs), [`bench/analyze.py`](../bench/analyze.py)
(per-part + per-op tables), [`bench/scale.py`](../bench/scale.py) (scaling table). Stdlib only.

## Table 1 — whole-model latency vs context length

Sum of the 4 parts' graph execute times, mean ± std over 49 warm inferences per graph, `basic`
profiling, `burst`.

| context | prefill, 128-tok chunk (ms) | prefill tok/s | decode, 1 tok (ms) | decode tok/s |
|---|---|---|---|---|
| 512 | 259.3 ± 1.4 | 494 | 109.1 ± 0.7 | 9.2 |
| 1024 | 295.6 ± 1.1 | 433 | 123.4 ± 0.8 | 8.1 |
| 2048 | 368.5 ± 3.2 | 347 | 148.7 ± 1.2 | 6.7 |
| 3072 | 445.5 ± 2.3 | 287 | 177.1 ± 1.2 | 5.6 |
| 4096 | 503.6 ± 2.5 | 254 | 215.4 ± 1.6 | 4.6 |

```powershell
# per context length (512 1024 2048 3072 4096):
python bench\bench.py --parts 1,2,3,4 --cl <CL> --iters 50 --level basic --json-out results_basic_<CL>.json
python bench\scale.py
```

**Decode scales with the static context length, not with the live sequence length.** Every
`token_ar1_cl4096` inference reads the whole 4096-entry KV cache and a `[1,1,1,4096]` mask, so
decode cost is set by the *shape you loaded*, not by how far into the conversation you are. That is
the memory-bound behaviour BENCHMARK_PLAN §1 predicts, and it is why this bundle is the wrong
artifact for a long-running agent: 2.0× the per-token cost at 4K vs 512.

## Table 2 — per-part breakdown at cl4096

`basic` profiling, 50 inferences, mean ± std (warm), cold shown separately.

| part | layers | prefill (ms) | prefill cold | decode (ms) | decode cold |
|---|---|---|---|---|---|
| part1 — embedding | — | 0.61 ± 0.06 | 2.99 | 0.55 ± 0.02 | 3.04 |
| part2 — blocks 0–11 | 12 | 154.39 ± 0.89 | 156.22 | 68.78 ± 1.28 | 70.03 |
| part3 — blocks 12–23 | 12 | 150.84 ± 1.42 | 153.91 | 67.74 ± 0.36 | 70.28 |
| part4 — blocks 24–35 + LM head | 12 | 197.74 ± 1.88 | 205.04 | 78.30 ± 0.94 | 80.83 |
| **whole model** | 36 | **503.58 ± 2.52** | | **215.37 ± 1.63** | |

Context load (all 4 parts, cold, from the `INIT` events): **5.05 s** — consistent with the ~30 s
first-call penalty seen on the served path, which additionally builds a 64K KV cache.

part4 is ~28% slower than part2/part3 despite holding the same 12 blocks, because it also carries
the vocabulary projection — see below.

## Table 3 — per-op hot spots (HTP cycle counts)

From `--profiling_level detailed`, which emits a per-op cycle counter. ~8,090 instrumented ops per
12-block part.

| phase | part | ops | Σ cycles (mean/inference) | top ops by cycles |
|---|---|---|---|---|
| prefill | part1 | 1 | 24,724 | `node_embedding` 24,724 |
| prefill | part2 | 8,088 | 214,897,718 | `node_silu_10` 833,661 · `node_silu_11` 826,646 · `node_silu` 824,603 |
| prefill | part3 | 8,088 | 213,198,867 | `node_silu_22` 827,807 · `node_silu_23` 826,084 · `node_silu_17` 818,177 |
| prefill | part4 | 8,092 | 220,565,317 | **`node_linear_72` 10,701,650** · `node_silu_35` 829,073 |
| decode | part2 | 8,064 | 86,958,053 | `node_linear_20` 259,578 · `node_linear_18` 258,917 |
| decode | part3 | 8,064 | 87,600,784 | `node_linear_34` 255,403 · `node_linear_38` 253,449 |
| decode | part4 | 8,067 | 91,773,389 | **`node_linear_72` 6,034,936** · `node_linear_48` 230,458 |

```powershell
python bench\bench.py --parts 1,2,3,4 --cl 4096 --iters 50 --level detailed
python bench\analyze.py results.json
```

**The single hottest op in the network is the LM head.** `node_linear_72` in part4 — the
2560 → 151,936 vocabulary projection — costs **6.03 M cycles per decoded token, ~26× the next
busiest op** (230 K), and 10.7 M in prefill. A 151,936-token vocabulary on a 4B model is where the
tail of the decode budget goes; this is the concrete "where do the cycles live" answer for the
benchmark slide.

Phase character also shows up cleanly in *which* ops dominate: prefill's hot ops are the `silu`
activations over 128 positions (compute-bound elementwise work), decode's are the `linear`
projections (memory-bound weight reads for a single position).

**Cross-check:** part2 decode is 87.1 M accelerator cycles (detailed) in 63.67 ms of accelerator
time (basic) ⇒ ~1.37 GHz effective HTP clock, a plausible v73 burst clock. The two independently
measured runs agree.

## Caveats

1. **`detailed` profiling inflates wall time ~3×** — instrumenting ~8,000 ops per graph cost part2
   decode 468.07 ms/inference vs **68.78 ms** at `basic` (0.7 tok/s vs 4.6 tok/s whole-model). All
   latency in Tables 1–2 is `basic`; `detailed` is used only for the *relative* cycle attribution in
   Table 3. Quoting a latency from a `detailed` run would understate the NPU by ~3×.
2. **These are graph execute times summed across 4 parts.** Genie's own orchestration, the
   KV-cache hand-off between parts, sampling and detokenization are excluded, so real end-to-end
   Genie throughput on this bundle would be *lower*, not higher.
3. **This bundle decodes slower than the GGUF path that actually serves the agent** — 9.2 tok/s at
   its shortest shape (cl512) and 4.6 tok/s at cl4096, vs ~15–16 tok/s measured for
   `Q4_0` via GenieX's llama.cpp Hexagon backend. It is easy to assume the "native qairt NPU
   bundle" must be the fast one; on this evidence it is not. Contributing factors: the static
   full-context attention shape, four separate context executions per token, and a different kernel
   set. **Do not present the W4A16 bundle as the performance path.** Its value here is that it is
   per-op profilable, which the GGUF path is not.
4. Zero-valued inputs mean outputs are meaningless; this measures timing only, never quality.
5. Single device, single session, no thermal soak. Sustained-load behaviour is untested.

## What this closes, and one bug found

**Audit risk P2 — "quad-profile on LLM bundles unverified" — is resolved: the profiler does not
reject LLM bundles.** All 8 target graphs ran `rc=0`. The two real obstacles were (a) the QAIRT
version/blob mismatch and (b) per-graph input plumbing that no QUAD tool generates. The
BENCHMARK_PLAN §3 fallback (tok/s harness + QAIRT Visualizer) is **not** needed.

### Which QUAD MCP tool applies to this workload, and how far each got

The short version: **8 of the 9 tools do not apply to a prebuilt Genie LLM bundle on a laptop whose
MCP server lives in the cloud.** Recorded so nobody re-litigates it under time pressure.

| Tool | What it does | Verdict here |
|---|---|---|
| `profile_device_plan` | Returns a recipe: files + shell steps + parse strategy | ✅ **Used** — gave the canonical `cli:qnn-net-run` shape |
| `profile_device_report` | Parses client-run output into a report | ⚠️ **Used, buggy** — see below |
| `hardware_detect` | Probes the **server's** host | ❌ Returns the cloud VM (AMD EPYC 7B12, Ubuntu, `runtimes: [cpu]`), not this X Elite |
| `profile_workload` | Profiles on the server host, or a device the server can reach | ❌ Server has no Hexagon and no access to this disk; the 3.0 GiB bundle is local |
| `profile_device` | Server drives the device over ssh/adb/local | ❌ Server cannot reach this laptop |
| `convert_model` | ONNX/PyTorch/TF/TFLite → `.bin`/`.dlc`/`.pte`, int8/int4 | ❌ Not needed — bundle is prebuilt by AI Hub |
| `aihub_select` | Catalog pick/search/compat/get/stage/ensure/pull/build | ❌ Not needed — GenieX already cached W4A16 |
| `generate_code` | Inference boilerplate per (platform, language, sdk) | ❌ Not needed |
| `orchestrate_workload` | Allocates graph nodes across CPU/GPU/NPU per power mode | ⚠️ **Deliberately not run** — see below |

**`orchestrate_workload` was skipped on purpose, and BENCHMARK_PLAN §3 names it.** It allocates
graph *nodes* across CPU/GPU/NPU by power mode. These four artifacts are already fully-compiled HTP
context binaries — the partitioning was fixed at AI Hub compile time and there is nothing left to
reallocate. Running it would emit a plausible-looking allocation table that describes a decision
this bundle does not expose, which is worse than an empty cell. If the slide needs the tool named,
say "not applicable to a precompiled Genie bundle" rather than showing its output.

**`profile_device_report` bug — reports a successful run as `FAILED`.** Fed the real device output,
it returns `ok: false`, `latency: null`, and the misleading diagnosis *"is qnn-net-run on the device
PATH, and is the model a valid BIN for this SoC's Hexagon version?"* Root cause: the plan sets
`parse: "snpe_net_run"`, but `qnn-net-run` prints no timings to stdout at all — they go to
`qnn-profiling-data_0.log` and must be read with `qnn-profile-viewer`. Worth filing upstream; every
number in this document had to come from the viewer CSVs instead.

`profile_device_plan` has two smaller gaps: it emits Linux shapes (`libQnnHtp.so`, `grep`) for a
Windows target, and it generates no `--input_list`, so it cannot execute a multi-graph LLM bundle
as-issued. It also *refuses* when told `model_kind="llm"` ("not supported over the CLI/NPU path")
but produces a valid plan for the same file when left to infer `kind` from the `.bin` extension.

## Not done yet — what this file does *not* contain

This is §3 only. Do not read it as "the benchmarks are done".

- **§1 — throughput of the *served* artifact. ✅ COMPLETE 2026-08-05 PM** — see
  [`../llm-serving-bench/RESULTS.md`](../llm-serving-bench/RESULTS.md): Q4_0+npu wins
  (**382 ± 8.3** prefill over 5 nonce-prefixed reps — the prefix cache was *not* flattering the
  old 375 — / 14.2 decode, tool-calls PASS); the CPU column is in (35 ± 7.2 / 11.3 ± 2.5,
  modeled agent-iter **371 s vs NPU ~41 s ≈ 9×**, plus visible thermal throttling 46→27 tok/s);
  gpu disqualified (HTTP 500 on any `tools` request); Q4_K_M-on-npu demonstrates the silent CPU
  fallback (31/7.5 tok/s).
- **§2 — Joules/query. ✅ MEASURED 2026-08-05 PM** — full table + method in
  [`../llm-serving-bench/RESULTS.md`](../llm-serving-bench/RESULTS.md): **NPU 471 J/query**
  measured directly at the real 12.5K agent shape (system power 11.7 → 18.0 W, i.e. inference
  adds just +6.3 W); CPU 1,278 J/query at the 3.9K shape → **0.327 vs 0.0375 J per
  prompt-token = ~8.7× more energy on CPU**, ~4,100 J scaled to the agent shape. Method:
  HWiNFO 8.50 **CSV log** integration (the ARM64 build does not publish SM2 shared memory —
  the checkbox exists but no mapping appears; CSV logging is the working path), trapezoidal
  rule, 60 s idle baseline, `System [W]` rail. Precedent arXiv 2606.11257 (4.0× on a
  decode-heavier mix; prefill-dominated agent workloads widen the NPU advantage).
- **§4 — screenshots.** The output contract asks for the Task Manager NPU graph during NPU-mode
  generation, the HWiNFO sensor panel, and a QAIRT Visualizer op view. **None captured** — all three
  need a human at the GUI. The Visualizer inputs (`qnn-profiling-data_0.log` per graph) are now
  in-repo under [`../bench/artifacts/out/`](../bench/artifacts/) — no longer only in `%TEMP%`.
- **Long-context prefill: ✅ MEASURED 2026-08-05 PM** (direct, single requests against the
  production server; full curve + crash forensics in
  [`../llm-serving-bench/RESULTS.md`](../llm-serving-bench/RESULTS.md)):
  **12,543 tok → 60.9 s (206 tok/s)** — so the honest agent iteration at the real request shape
  is ~68 s, not the modeled ~41 s; **31,775 tok → 293 s (108 tok/s)** — the worst case Hermes can
  ever send (compression fires at 32K), safely inside the 900 s stale ceiling with 3× headroom;
  **~60K tok → server crash** (`ggml-hex: dspqueue_read failed: 0x00000072`) — GenieX v0.3.18
  accepts `--nctx 65536` but cannot actually serve a ~60K prompt on NPU. A true 64K prefill is
  therefore *unreachable* on this stack today; the compression threshold (0.5) is the guard —
  do not raise it. Also reproduced: a second Hexagon process (bench on 18191) destabilizes the
  DSP and can wedge it for the production process — only bench when production can be restarted.
