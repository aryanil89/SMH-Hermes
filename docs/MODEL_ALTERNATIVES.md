# Model alternatives research — 2026-08-05 (research only, nothing implemented)

Question: is Qwen3-4B-Instruct-2507 (Q4_0, GenieX/Hexagon) the best model for this agent, or
does something better exist as of Aug 2026?

**Answer: it is no longer the best ~4B on paper — but it is still the best model this NPU can
fully run.** The entire 2026 small-model crop (Qwen3.5, Granite 4.x, Nemotron Nano, Gemma 4
E-series) moved to hybrid attention (DeltaNet / Mamba), which llama.cpp's Hexagon backend cannot
offload — those layers silently fall back to CPU, exactly the trap we measured with Q4_K_M
quantization. Our baseline is the local optimum for this stack, not a compromise; that's a
slide-worthy finding in itself.

Hard constraints any candidate must meet: ≥64K context (Hermes floor) · reliable OpenAI tool
calling · Q4_0/Q8_0/MXFP4 quant (all the Hexagon backend accepts) · ≤~20 GB incl. 64K KV ·
GGUF available.

## Ranked shortlist (benchmark candidates, in order)

1. **gpt-oss-20b (MXFP4_MOE)** — the only plausible step-change. MoE, ~3.6B active (≈ our 4B
   compute), o3-mini-class quality, native MXFP4 (the ideal Hexagon format), 131K ctx,
   ~14–15 GB with KV (sliding-window layers make 64K KV cheap). Risks: needs **four Hexagon
   sessions** (llama.cpp layer-split; unknown whether GenieX v0.3.18 exposes it) and its
   harmony tool-call format is translated by the server — must pass our tool-call gate before
   any commitment. Expected speed ≈ 0.7–1.1× baseline.
2. **Qwen3.5-4B** (Feb 2026) — the quality successor (better reasoning/long-context/agentic;
   262K ctx; Q4_0 GGUF exists) but its DeltaNet attention runs on **CPU** on this stack; the
   only NPU kernel is an unmerged third-party patch that is *slower than CPU*. Benchmark only
   to quantify the fallback penalty. Becomes the obvious upgrade the day the Hexagon backend
   gains DeltaNet kernels.
3. **Ministral 3 (3B)** — standard transformer (NPU-friendly), 256K ctx, native function
   calling claimed, ~1.15–1.3× baseline speed expected. Low risk, but quality delta may be ~0.
   Confirm a Q4_0 GGUF exists before bothering.
4. **Qwen3.5-2B** — cheap curiosity: if benchmarked on CPU it may embarrass the NPU numbers
   (hybrid models are very fast on Oryon), which is worth knowing before someone asks.

Rejected outright: Qwen3.6-35B-A3B and Nemotron-3-Nano-30B (weights alone bust RAM), Granite
4.x (Mamba fallback), LFM2.x (sub-64K context), Gemma 4 E-series (unproven architecture on
Hexagon + historically template-based tool calling).

## Decision rule (agreed)

No swap without numbers, no numbers without the gate: a candidate must PASS the OpenAI
tool-call test in `llm-serving-bench/bench.py`, beat the baseline's modeled agent iteration,
and survive one live Hermes MCP turn. Otherwise Qwen3-4B-Instruct-2507 stays, and this
document is the "alternatives were evaluated" evidence.

## Addendum 2026-08-05 (second research pass, web-verified)

- **The baseline agent iteration is ~42 s, not ~32 s** — the 8K/150 request shape the gate
  originally modeled understated the measured Hermes mean (12,670 prompt / 105 completion
  tokens, state.db). `bench.py` now scores with the measured shape and takes `--model`, so the
  gate runs without editing the file: `python bench.py --model <hf-repo:quant> --modes npu`.
- **Weight candidates ~12:1 on prefill.** Measured input:output is ~120:1 and the winning
  config spends ~82% of an iteration in prefill — decode deltas barely move the score. This
  strengthens Ministral-3 (dense transformer, full NPU prefill) relative to its ranking above,
  and makes gpt-oss-20b's four-session dispatch overhead its make-or-break number.
- **One check against gpt-oss-20b's #1 slot:** on the agentic benchmark closest to our
  workload it is *weaker*, not stronger, than Qwen3.5-4B — tau-bench Retail 54.8 (OpenAI model
  card) vs Qwen3.5-4B's reported TAU2 79.9 — while costing ~3× the memory. Its "o3-mini-class"
  reputation is general-reasoning, not tool-calling. Also still unconfirmed anywhere: an
  X Elite NPU bundle (the `qualcomm/GPT-OSS-20B` HF repo is gated; an onnxruntime NPU request
  from 2025-08 sits unanswered) and any published X Elite tok/s.
- Net: the conclusion above stands — **keep Qwen3-4B-Instruct-2507** — and the honest slide
  line is: "evaluated Qwen3.5-4B, gpt-oss-20b, Ministral 3; kept the only candidate with a
  validated NPU tool-calling path."

Full sources (model cards, llama.cpp snapdragon docs, GenieX README, benchmark comparisons)
are cited in the research transcript; key ones: huggingface.co/Qwen/Qwen3.5-4B ·
unsloth.ai/docs/models/qwen3.5 · github.com/ggml-org/llama.cpp docs/backend/snapdragon ·
openai.com/index/introducing-gpt-oss · github.com/ara142/llama-cpp-hexagon-npu (DeltaNet
NPU patch, measured slower than CPU).
