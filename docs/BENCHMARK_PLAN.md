# Benchmark Plan — methodology

How this project measures its performance and energy claims. This page fixes the *method* so the
numbers are reproducible and honestly scoped.

> **Status 2026-08-04:** **§3 is done** — results in [BENCHMARKS.md](BENCHMARKS.md), harness in
> [`../bench/`](../bench/). **§1 (throughput of the served GGUF), §2 (Joules/query) and the §4
> screenshots are still outstanding.** Note §3's stated fallback proved unnecessary: the profiler
> does *not* reject LLM bundles. Note also that `orchestrate_workload`, named in §3 below, was
> deliberately **not** run — it reallocates graph nodes across CPU/GPU/NPU, and a precompiled Genie
> context binary exposes no such decision. Raw serve logs from the initial spike
(`geniex-serve-*.log`) are the inputs for sanity-checking, not the evidence itself.

## 1. Throughput — prefill and decode, reported separately

One blended tokens/sec number hides exactly what the NPU changes, because the two phases of LLM
inference have opposite bottlenecks:

- **Prefill** (processing the prompt) is **compute-bound** — large matrix multiplies.
- **Decode** (generating tokens one at a time) is **memory-bound** — KV-cache reads dominate.

So we follow the llama-bench convention: **pp** (prompt processing) and **tg** (text generation)
measured and reported separately, **r ≥ 5 repetitions**, reported as **mean ± std**.

| Parameter | Value |
|---|---|
| Model artifact | `unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0` (the artifact actually served to the agent) |
| Server | `geniex serve --nctx 65536` |
| Compute modes | `--compute npu` vs `--compute cpu` vs `--compute hybrid` — same artifact, same prompts |
| Prefill probe | fixed prompt of a known token count (≥512 tokens), time to first token |
| Decode probe | fixed `max_tokens` generation (≥128), tokens ÷ decode wall time |
| Repetitions | ≥5 per cell, first (cold-load) run reported separately, not averaged in |

Known from the initial spike and to be confirmed under this methodology: decode ~15–16 tok/s on
NPU with CPU load at 12–17% (vs 56–74% on CPU fallback); prefill NPU 12.5s / hybrid 18.5s /
GPU 5.2s on the trimmed Telegram prompt — **GPU mode reproducibly fails tool-enabled requests**
(`SDKError(Model loading failed)`, GenieX preview bug), so GPU appears in throughput tables only,
never in the serving config.

## 2. Energy — Joules per query, with the platform limitation stated up front

**The Snapdragon X1 Elite does not expose direct NPU power telemetry** — no tool can read NPU watts
on this generation (see the [HWiNFO forum discussion](https://www.hwinfo.com/forum/threads/i-am-trying-to-get-total-cpu-power-consumption-and-npu-metrics-using-a-tool-called-hwinfo64-but-unable-to-find-the-sensor-for-total-power-consumption.10053/)).
We therefore use the methodology published for **this same silicon** in
[Energy-Efficient On-Device RAG on a Mobile NPU (arXiv 2606.11257)](https://arxiv.org/html/2606.11257v1):

1. Sample **HWiNFO64** sensors (CPU cluster power rails, system total) from shared memory at a
   fixed interval for the duration of each query.
2. Numerically integrate instantaneous power over the run → **Joules per query**.
3. Pair with **Task Manager's NPU utilization graph** (screenshot during the run) as the
   attribution evidence that the offloaded configuration is actually using the NPU.
4. Report the **delta between compute modes** for the same query — the NPU claim is the
   *difference*, not an absolute NPU-watts figure we cannot measure.

This gives an honest, reproducible energy-efficiency comparison without claiming telemetry the
hardware doesn't provide.

## 3. Per-op evidence — QUAD profiling on the NPU bundle

`profile_workload` / `orchestrate_workload` (QUAD MCP server) run against
`qualcomm/Qwen3-4B-Instruct-2507:W4A16` — the AI Hub NPU bundle.

**Honest labeling, stated wherever these numbers appear:** the profiled artifact is *not* the
served artifact. Same weights, two builds — the W4A16 qairt bundle is profilable per-op on the
Hexagon path but caps at 4K context without tool-call parsing; the served Q4_0 GGUF runs via
GenieX's llama.cpp Hexagon backend with 64K context and tool calls
(see [ARCHITECTURE.md §4](ARCHITECTURE.md#4-one-model-two-artifacts)). Per-op HTP cycle counts
from the bundle characterize the model-on-Hexagon; §1–§2 above characterize the system actually
demoed.

**Fallback:** if the profiler rejects LLM bundles (untested risk, flagged in
[AUDIT_2026-08-03.md](AUDIT_2026-08-03.md) as P2), the §1 harness plus a **QAIRT Visualizer**
inspection of the bundle (op graph, source-vs-compiled mapping) is the substitute evidence chain.

## 4. Output contract

`docs/BENCHMARKS.md` will contain, for each table, the exact command that produced it, the
repetition count, and mean ± std — plus screenshots: Task Manager NPU graph during NPU-mode
generation, HWiNFO sensor panel, and (if §3 succeeds) the QUAD profile report and QAIRT
Visualizer op view.
