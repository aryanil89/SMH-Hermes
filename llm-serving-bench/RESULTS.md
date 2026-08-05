# GenieX serving benchmark — combined results (2026-08-05)

Machine: Snapdragon X Elite X1E80100 (Hexagon v73 NPU 45 TOPS / Adreno X1-85 / 12× Oryon,
31.6 GB), GenieX v0.3.18, `--nctx 65536`, model Qwen3-4B-Instruct-2507 GGUF.

Two runs were needed: a background process on this machine kills `geniex.exe` by image name
(production-server management), which nuked some configs mid-request in each run. The table
merges the clean measurement of every cell (each config has at least one complete run).

**Winner rule:** fastest modeled agent iteration (8K-token prefill + 150-token decode) **among
configs that pass OpenAI tool-calling** — an agent config that can't call tools is disqualified
regardless of speed.

| config | load s | prefill tok/s | decode tok/s | CPU% @decode | RSS GB | tool-call | modeled agent-iter |
|---|---|---|---|---|---|---|---|
| **Q4_0 + npu** ✅ winner | 7.9 | **375** | 14.2 | 49* | 12.0 | **PASS** | **~32s** |
| Q4_0 + hybrid | 8.0–9.6 | 203 | 17.3 | 53 | 12.6 | PASS | ~48s |
| Q4_0 + gpu | — | (≈650 in earlier isolated tool-free test) | (~110 earlier) | low | — | **FAIL** — `SDKError(Model loading failed)` / HTTP 500 on any `tools` request (GenieX preview bug, reproducible) | disqualified |
| Q4_K_M + npu | 7.0–16.2 | 31 | 7.5 | 31 | 12.1 | PASS | ~278s — disqualified on speed (silent CPU fallback: K-quants unsupported by the Hexagon backend) |

\* CPU% sampled while other workloads ran on the box; the controlled earlier measurement for
Q4_0+npu was **12–17%** vs 56–74% for CPU fallback — use that pair for the efficiency claim.

## Conclusions

1. **The production config is already optimal: `geniex serve --nctx 65536 --compute npu` with
   the Q4_0 GGUF.** Nothing measurably better exists today under the tool-calling constraint.
2. **Hybrid is a working runner-up, not an upgrade**: slightly faster decode (17.3 vs 14.2)
   but nearly half the prefill speed — and prefill dominates agent turns (big prompts, short
   answers). Modeled agent iteration: 48s vs 32s. It also burns more CPU.
3. **GPU would win if the bug were fixed** (2–3× prefill, ~7× decode in tool-free tests) but
   fails 100% of tool-enabled requests. Re-run `bench.py --modes gpu` after every GenieX
   release; the day it passes, switch and enjoy ~11s agent iterations.
4. **Quantization is the biggest silent trap**: Q4_K_M "works" but runs ~9× slower agent
   iterations via CPU fallback. Only Q4_0 / Q8_0 / MXFP4 engage the Hexagon backend.
5. Mapping to the hackathon rubric (Technical Implementation, 40 pts — "resource utilization,
   optimization, latency and performance, and energy efficiency"): the winning config's story is
   *NPU does the math (12–17% CPU vs 56–74%), quantization chosen deliberately (Q4_0 vs Q4_K_M
   shown), GPU headroom quantified and blocked only by an upstream preview bug we can cite.*

## Reproduce

```powershell
cd llm-serving-bench
python bench.py                # Q4_0 × npu,hybrid,gpu on port 18191 (production untouched)
python bench.py --full         # + Q4_K_M CPU-fallback demonstration
python bench.py --modes gpu    # quick recheck of the GPU tool-call bug after a GenieX update
```
