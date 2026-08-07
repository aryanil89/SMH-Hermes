# GenieX serving benchmark — combined results (2026-08-05, final)

Machine: Snapdragon X Elite X1E80100 (Hexagon v73 NPU 45 TOPS / Adreno X1-85 / 12× Oryon,
31.6 GB), GenieX v0.3.18, `--nctx 65536`, model Qwen3-4B-Instruct-2507 GGUF.

This table merges the clean measurement of every cell across three runs (2026-08-05 AM
hand-merged run-1, PM `--modes npu,cpu` run, PM NPU re-run). Cells marked † are from run-1;
everything else is the PM runs (5 reps, nonce-prefixed prefill, mean ± std).

**Winner rule:** fastest modeled agent iteration (12,670-token prefill + 105-token decode —
the measured Hermes request shape from state.db) **among configs that pass OpenAI
tool-calling** — an agent config that can't call tools is disqualified regardless of speed.

| config | load s | prefill tok/s | decode tok/s | CPU% @decode | RSS GB | tool-call | modeled agent-iter* |
|---|---|---|---|---|---|---|---|
| **Q4_0 + npu** ✅ winner | 7.4 | **382 ± 8.3** | 14.2† (14.5/14.0 today corroborate) | 12–17†\*\* | 12.0 | **PASS**† | **~41s** (direct-measured: **68s**, see below) |
| Q4_0 + hybrid† | 8.0–9.6 | 203 | 17.3 | 53 | 12.6 | PASS | ~69s |
| Q4_0 + cpu | 9.1 | 35 ± 7.2 | 11.3 ± 2.5 | 33 | 11.6 | PASS | ~371s |
| Q4_0 + gpu† | — | (≈650 tool-free) | (~110 tool-free) | low | — | **FAIL** — `SDKError(Model loading failed)` / HTTP 500 on any `tools` request (GenieX preview bug) | disqualified |
| Q4_K_M + npu† | 7.0–16.2 | 31 | 7.5 | 31 | 12.1 | PASS | ~423s — silent CPU fallback (K-quants unsupported by Hexagon) |

\* modeled = 12,670 / prefill-rate + 105 / decode-rate, using the **short-prompt** (3.9K)
prefill rate — valid for comparing configs, optimistic in absolute terms (see curve below).
\*\* controlled earlier measurement; the run-1 sampled 49% had other workloads on the box.

## Long-context prefill curve (direct, single requests vs production server, NPU)

| prompt tokens | wall time | prefill tok/s | note |
|---|---|---|---|
| 3,867 (bench mean) | 10.1 s | 382 | 5 reps, ± 8.3 |
| 12,543 | 60.9 s | 206 | the real Hermes request shape |
| 12,545 / 12,543 | 72.6 s / 64.5 s | 173 / 194 | re-capture 2026-08-07 (cold-ish, then warm) — raw rows in `prefill-long-results.json`; the spread corroborates the row above and the cache-probe range below |
| 31,775 | 293.0 s | 108 | = Hermes compression threshold (0.5 × 65,536) |
| ~60,000 | **crash** | — | `ggml-hex: dspqueue_read failed: 0x00000072` |

Prefill throughput roughly halves each ~2.5× context growth. The honest agent-iteration
number at the real 12.7K shape is **60.9 s prefill + ~7 s decode ≈ 68 s** — use this, not
the modeled 41 s, when quoting absolute latency. The config ranking is unaffected (every
config degrades with context; NPU stays ~6–9× ahead of CPU).

## Prefix-cache probe (2026-08-05 PM)

GenieX v0.3.18 does **not** reuse KV across requests. At the 12.5K agent shape a
byte-identical repeat re-prefills at full cost (A-cold 77.4 s / B-exact-repeat
71.7 s / C-appended-turn 98.5 s), and the llama.cpp `cache_prompt: true` body
param changes nothing (B-exact-repeat 78.2 s). Every Hermes turn therefore pays
full prefill for the entire history — **prompt size is the only latency lever
available today**. Design implications: `docs/PERF-DESIGN.md`. Recheck per
GenieX release: `python cache_probe.py` (raw: `cache-probe-results.json`).

## Prompt composition — which block is actually big (2026-08-05 PM)

Since prompt size is the only lever, we measured where the tokens go. GenieX
exposes no `/tokenize` (404 on `/tokenize`, `/v1/tokenize`, `/detokenize`,
`/props`), so each block was sent alone with `max_tokens: 1` and
`usage.prompt_tokens` diffed against a trivial baseline — **real counts through
the production chat template**, not a chars/token estimate.

| block | measured tok | share of the 9,825 fixed overhead |
|---|---|---|
| Built-in Hermes tool schemas (residual vs the anchor) | **4,353** | 44% |
| System prompt (15,006 chars) | **3,435** | 35% |
| → of which the `## Skills (mandatory)` catalogue | **1,535** | 16% |
| MCP tool schemas (6 servers / 10 tools, 7,611 chars) | **2,028** | 21% |
| Chat-template framing | 9 | — |

Anchor: 9,825 tok = a fresh session with history=0, from the non-stream timeout
diagnosis. Against the real 12,670-token turn shape that leaves ~2,845 tok of
history — i.e. **78% of a request is fixed overhead and only 22% is conversation.**

Three findings that redirected the design work:

1. **MCP schemas are the *smallest* fixed block**, not the largest. Pruning
   `network`/`storage`/`compute` would save ~390 tok (~2 s) and break
   `get_incident_assessment`, the one-call-instead-of-four path. Prior guidance
   in `config.yaml` / `RUNBOOK.md` said to trim `mcp_servers` first; both have
   been corrected.
2. **The skills catalogue was pure dead weight** — 63 entries / 8,201 chars on
   every model call, of which one (`environmental-watch`) is used here. Cutting
   it via `skills.platform_disabled.telegram` measured **1,535 tok saved per
   call**: ~7.5 s at 206 tok/s, ~10.2 s at the degraded 150 tok/s late-session
   rate, and ~22 s on a 3-call turn (each tool call is its own re-prefill).
3. **The largest block has no config lever.** Built-in tool schemas are
   4,353 tok, but Hermes only disables tools at *toolset* granularity
   (`platform_toolsets`, `disabled_toolsets`) and the Telegram toolset is already
   trimmed to `[terminal, skills, cronjob]`. Cutting further means losing a whole
   toolset.

Reproduce: `python prompt_composition.py --prune-delta` (sends ~4 real
completions to the production server; run while it is idle, and do **not** start
a second geniex for it — see stability finding 2).

## Stability findings (all reproduced 2026-08-05)

1. **~60K prefill crashes GenieX v0.3.18 on NPU** (`dspqueue_read failed: 0x00000072`,
   `ggml-hexagon.cpp:1583`) even though `--nctx 65536` is accepted and KV is preallocated.
   32K survives (293 s continuous prefill). Real ceiling is somewhere in (32K, 60K) —
   untested. **Production is guarded**: Hermes `compression.threshold: 0.5` compresses at
   32K, so the agent never sends a larger prompt. Do not raise that threshold.
2. **A second Hexagon process destabilizes the DSP.** Running bench servers on 18191 while
   production (18181) was attached crashed the bench server twice (2/2) and left the DSP
   wedged — the production server then died on its next inference. Run NPU benchmarks only
   when the production server can tolerate a restart afterward; recovery = restart geniex
   (~20 s, verified clean).
3. **The 293 s worst-case turn validates `providers.custom.stale_timeout_seconds: 900`**
   in Hermes config.yaml: the old 180 s stale-kill would abort every near-threshold turn;
   900 s leaves ~3× headroom.
4. **CPU mode throttles**: prefill drifted 46 → 27 tok/s across 5 back-to-back reps
   (thermal). The NPU held 382 ± 8.3 over the same pattern.

## Session token budget (demo guidance)

- Fresh session, first turns (~10–13K ctx incl. tool schemas): **~1 min/turn**.
- Near the 32K compression ceiling: **~5 min/turn** (293 s prefill dominates).
- For the Friday demo: **reset the Telegram session beforehand** so turns stay in the
  ~1 min band; compression caps the worst case at ~5 min either way.

## Energy — Joules per query (measured 2026-08-05 PM)

Method: HWiNFO 8.50 CSV log (`System [W]` rail, ~2 s cadence — the ARM64 build does not
publish the SM2 shared memory, so `energy.py --csv` integrates the sensor log instead),
trapezoidal integration, 60 s idle baseline subtracted; both servers idle-resident during
baseline and load phases, so attribution is clean. Same method as arXiv 2606.11257.

| config | query shape | n | idle W | load W | net J/query | J per prompt-token |
|---|---|---|---|---|---|---|
| **NPU** (production server) | 12.5K in / ~41 out | 5 | 11.66 | 18.00 | **471** | **0.0375** |
| CPU (dedicated 16K-ctx server) | 3.9K in / 33 out | 2* | 10.86 | 32.15 | 1,278 | 0.327 |

\* the environment's geniex process manager killed the CPU server mid-run twice at the
12.7K shape and at query 3 of the short shape; the protocol keeps completed queries.

- **CPU burns ~8.7× more energy per token than the NPU** (0.327 vs 0.0375 J/prompt-token,
  consistent across both measured shapes).
- Scaled to the real 12.7K Hermes query: **~4,100 J on CPU vs 471 J measured on NPU**.
  Linear scaling is conservative: CPU attention cost is superlinear and the CPU throttles
  under sustained load (query 1 ran 36 s at boost clocks, query 2 already 86 s).
- Power deltas tell the efficiency story on one line: NPU inference lifts the whole system
  only **+6.3 W** over idle; CPU lifts it **+21.3 W** — and still takes ~7× longer.
- Precedent on this SoC: arXiv 2606.11257 reports 315 vs 1,251 J/query (4.0×) with a
  decode-heavier mix; our prefill-dominated agent shape widens the NPU advantage.

Reproduce: `python energy.py --run --label npu --csv <hwinfo.csv> --sensor System`, then
`python -u run_cpu_energy.py` (starts/stops its own CPU server). Raw: `energy-results.json`.

## Conclusions

1. **Production config confirmed optimal: `geniex serve --nctx 65536 --compute npu` + Q4_0
   GGUF.** Nothing measurably better exists under the tool-calling constraint.
2. **NPU vs CPU on identical model/quant: ~9× faster agent iterations modeled (41 s vs
   371 s), ~6× measured at the CPU's own optimistic rate — and 12–17% CPU load vs 33%+
   with thermal throttling.** This is the rubric's "resource utilization & optimization"
   number.
3. **Hybrid is a runner-up, not an upgrade** (faster decode, half the prefill — and agent
   turns are 82% prefill).
4. **GPU would win if the tool-call bug were fixed** (2–3× prefill in tool-free tests);
   recheck each GenieX release: `python bench.py --modes gpu`.
5. **Quantization is the biggest silent trap**: Q4_K_M runs ~10× slower agent iterations
   via CPU fallback. Only Q4_0 / Q8_0 / MXFP4 engage Hexagon.

## Reproduce

```powershell
cd SMH-Hermes\llm-serving-bench
python bench.py --modes npu,cpu        # short-prompt table rows (port 18191)
python bench.py --full                 # + Q4_K_M CPU-fallback demonstration
python prefill_long.py                 # 12.7K + 60K direct probes (WARNING: 60K crashes
                                       #   the server it targets — restart after)
python prefill_long.py --reps 992 --label 32K   # the compression-threshold probe
python energy.py --run --label npu     # J/query (needs HWiNFO shared memory ON)
```

Raw data: `results.json` + `archive/` (per-run JSONs and tables, timestamped),
`prefill-long-results.json`, `serve-*.log` (crash signatures).

## Phone benchmark (Snapdragon 8 Elite) — 2026-08-06

Device: Samsung Galaxy S25 Ultra (SM-S938U1, SM8750, Hexagon `dsp_arch v79`, 11.4 GB
MemTotal / 5.4 GB available at start, Android 15), on USB power, serving as the live
approval terminal before and after the run. Model: `qualcomm/Qwen3-4B-Instruct-2507`
pre-compiled AI Hub Genie bundle — **w4a16**, ctx **4096**, compiled with QAIRT 2.45
(bundle SHA-256 in `phone/phone-results.json`). Runner: `genie-t2t-run` from the QAIRT
2.45.0.260326 Community SDK (aarch64-android, libGenie 1.17.0) over `adb` — a **one-shot
CLI, not a serving endpoint**. Prompt: fixed 1,248-token ops summary, nonce-prefixed per
rep. One warmup rep + 5 measured, back-to-back deliberately (rep-over-rep decay is the
thermal signal).

| metric | value | note |
|---|---|---|
| prefill | **1,918.0 ± 16.9 tok/s** | n=5, 1,248-token prompt |
| decode | **23.1 ± 1.3 tok/s** | n=5, 119–136 generated tokens per rep |
| TTFT | **0.65 ± 0.01 s** | from `--profile` (excludes model load) |
| model load | 4.1 ± 0.2 s warm, 4.27 s cold | 3.2 GB context binaries, mmap |
| thermal | battery 29.5 → 31.8 °C over 6 reps | decode reps 1–3 ≈ 24.1, reps 4–5 ≈ 21.7 tok/s (~10% dip); prefill flat |

**Not the laptop's config** — different quantization (w4a16 QNN context binaries vs Q4_0
GGUF), context (4,096 vs 65,536), runner (one-shot CLI vs GenieX OpenAI serving), prompt
length (1,248 vs 3,867 tokens), and a phone chassis. This table answers "does the same
model run on the second Hexagon, and how fast there" — not "which NPU wins under
identical conditions". The 12 GB memory risk flagged in `phone/README.md` did not bite at
ctx 4096: ~5.4 GB available before load, no OOM, the phone stayed usable throughout.

**Not tested on the phone:** tool-calling, an OpenAI-serving endpoint, sustained load,
energy per query, context beyond 4096. The bundle is HTP-only context binaries, so there
is no on-phone CPU comparison to run. The laptop remains the only claimed serving path.

Reproduce (PowerShell host; phone needs USB debugging on and Samsung **Auto Blocker OFF**):

```powershell
# Both downloads are public, no login. Bundle URL is in phone/phone-results.json.
curl.exe -LO <bundle-url>          # 2.4 GB, w4a16 8 Elite Genie bundle
curl.exe -LO https://softwarecenter.qualcomm.com/api/download/software/sdks/Qualcomm_AI_Runtime_Community/All/2.45.0.260326/v2.45.0.260326.zip
# Extract both; adb push to /data/local/tmp/hermes-npu-bench/: bundle -> bundle/,
#   SDK lib/aarch64-android -> qairt/lib, bin/aarch64-android/genie-t2t-run -> qairt/bin,
#   lib/hexagon-v79 -> qairt/hexagon-v79, plus phone/run.sh from this repo.
adb shell "sh /data/local/tmp/hermes-npu-bench/run.sh 1 v79"   # one rep; KPIs land in profile-rep1.json
```

Raw: `phone/` — per-rep logs, `--profile` JSONs, the `run.sh` harness, `phone-results.json`
(per-rep table + bundle hash + URLs). Prompt passed via `--prompt_file` — `-p` over
`adb shell` loses its quoting and splits the prompt into bogus argv (first smoke log shows
the failure mode).

### The failover round-trip, decomposed — n=5, 2026-08-07

The table above benchmarks the phone. This one measures **what the demo actually pays** when
GenieX is dead and a real question routes to it: the whole phone leg, prompt push to answer
parsed, from the installed hook's own code path (`handler.py --try`, which sends nothing and
never touches GenieX). Driver: `phone/failover-reps.ps1`; raw logs and per-rep `--profile`
JSONs in `phone/failover-reps/`. Five different one-sentence questions, not one question five
times — an identical prompt would measure a cache this runtime does not have.

| metric | value | note |
|---|---|---|
| **phone leg, wall clock** | **7.1 ± 0.7 s** | n=5, 5.9–7.6 s, all 5 succeeded |
| model load (`GenieDialog_create`) | **3.83 ± 0.04 s** | paid **per question** — see below |
| prefill | 1,100 ± 43 tok/s | 131–135-token prompts |
| decode | 25.8 ± 1.0 tok/s | 40–84 generated tokens per rep |
| TTFT | 0.12 ± 0.01 s | excludes model load |
| teardown (`GenieDialog_free`) | 0.14 s | flat |

**Model load is 54% of the answer, and it is structural.** The failover path is a one-shot
`genie-t2t-run` per question — there is no persistent endpoint on the phone — so every
question reloads 3.2 GB of context binaries before it can read a single token. That is the
concrete cost of the gap already named in the README ("on-phone *serving*" is the not-built
item), and it is why the phone leg is ~7 s while the phone itself decodes at 25.8 tok/s. It
is also the one number that would move most if the phone ever ran a served endpoint.

**Why prefill reads 1,100 here and 1,918 above.** Prompt length, not disagreement: the bench
prefills 1,248 tokens, the failover prefills ~134. Per-call fixed overhead amortizes over the
longer prompt, so the same phone reports a higher rate on the bigger prompt. Quote whichever
matches the prompt you are describing, never the larger one by default. Decode (25.8 vs 23.1)
sits within run-to-run variation of two short runs at different generated-token counts, and
these reps were short enough not to reach the thermal decay the 6-rep bench shows.

**Answer length dominates the variance.** The reps run 162 → 407 characters and 5.9 → 7.6 s in
the same order, which is what a decode-bound leg should look like. The whole leg is predicted
to within 0.1 s by *3.8 s load + 0.12 s TTFT + gtok/25.8 + ~0.3 s adb*, so read it as
**~4.0 s fixed + ~0.04 s per generated token**, not as a single constant — an earlier n=1
measurement of 9.3 s was a longer answer, not a slower phone.

**Reproducibility.** An identical run of the same driver 20 minutes earlier gave 7.3 ± 0.4 s
(6.7–7.8, 5/5) with the same prompts. Both runs are the same distribution; the artifacts
committed here are the second one, so that the numbers above and the files beside them are the
same measurement rather than a close cousin.
