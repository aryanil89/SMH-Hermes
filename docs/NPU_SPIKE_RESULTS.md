# NPU Spike Results — 2026-08-03

Empirical resolution of the two blocking risks from [AUDIT_2026-08-03.md](AUDIT_2026-08-03.md)
(P0: Hermes 64K context vs 4K NPU bundles; P1: tool-calling through `geniex serve`), run live on
the target laptop (Snapdragon X Elite X1E80100, 32 GB, Hexagon v73, QAIRT 2.45).

## Environment installed

| Component | Version / location |
|---|---|
| GenieX CLI | v0.3.18, `C:\Users\qc_de\AppData\Local\GenieX CLI\geniex.exe` (Inno installer, on user PATH) |
| GenieX Python bindings | 0.3.18 in `C:\Users\qc_de\Downloads\QUAD\.venv-geniex` (native ARM64 Python 3.12) |
| QAIRT runtime | v2.45.0.260326 (bundled) |
| Models cached | `qualcomm/Qwen3-4B-Instruct-2507:W4A16` (NPU/qairt bundle, 3.0 GiB); `unsloth/Qwen3-4B-Instruct-2507-GGUF` in `Q4_K_M` and `Q4_0` |

Devices seen by GenieX's llama.cpp runtime: **HTP0 (Hexagon)**, Adreno X1-85 (OpenCL), Oryon CPU.

## Test matrix (all via `geniex serve` → `POST /v1/chat/completions` with OpenAI `tools`)

| Path | Tool call parsed? | 64K context? | Compute evidence |
|---|---|---|---|
| **qairt NPU bundle** (W4A16) | ❌ `tool_calls: null` — model emitted the correct call but as plain text wrapped in mis-decoded marker tokens ("ФРАГМЕНТ") | ❌ fixed 4096 | Hexagon (qairt path) |
| **GGUF Q4_K_M**, `--nctx 65536 --compute npu` | ✅ proper `tool_calls` array | ✅ (server RSS 11.9 GB ≈ weights + 64K KV cache) | ❌ CPU fallback — 56–74% total CPU on 12 cores (Q4_K_M unsupported by the Hexagon backend) |
| **GGUF Q4_0**, `--nctx 65536 --compute npu` | ✅ proper `tool_calls` array (`finish_reason: "tool_calls"`) | ✅ (RSS 11.9 GB) | ✅ CPU drops to **12–17%** during generation — compute offloaded to Hexagon |

Timing (600-token essay generation, warm): Q4_K_M/CPU ≈ 40.6 s; Q4_0/NPU ≈ 38.2 s — **similar
throughput (~15–16 tok/s decode), at roughly one-quarter of the CPU load**. The NPU win here is
power/CPU-headroom, not raw speed. First call after server start adds ~30 s model load.

## Conclusions

1. **P0 and P1 are simultaneously solved by one configuration:**
   ```
   geniex serve --nctx 65536 --compute npu
   ```
   with model **`unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0`**. OpenAI-compatible endpoint at
   `http://127.0.0.1:18181/v1`, real structured tool calls, 64K context, NPU-offloaded compute.
   This is the Hermes provider config:
   ```yaml
   # %LOCALAPPDATA%\hermes\config.yaml (provider excerpt) -- HERMES_HOME on this
   # native-Windows install; there is no ~/.hermes directory here
   provider: custom
   base_url: http://127.0.0.1:18181/v1
   model: unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0
   context_length: 65536
   ```
2. **The qairt W4A16 bundle cannot drive Hermes** (4K ctx, no tool-call parsing). Keep it for the
   benchmark/demo beat — same model, showcase Hexagon path.
   **Update 2026-08-04:** it has now been profiled per-op on Hexagon v73 —
   [BENCHMARKS.md](BENCHMARKS.md). Two results that change how it should be presented: prefill
   measures **254 tok/s @cl4096**, independently corroborating the ~280 tok/s figure below; but
   decode is **4.6 tok/s @cl4096 / 9.2 @cl512**, i.e. *slower* than the ~15–16 tok/s the Q4_0 GGUF
   path delivers. Do not present the bundle as the fast path — its value is that it is per-op
   profilable, which the GGUF path is not.
3. **Quantization is load-bearing:** Q4_K_M silently falls back to CPU on the Hexagon backend.
   Only Q4_0 (or Q8_0/MXFP4) engages the NPU. Any model swap must re-check this.
4. **Caveats to keep honest:** the llama.cpp Hexagon backend is experimental; NPU attribution is
   inferred from the CPU-load delta (12–17% vs 56–74%) plus GenieX's HTP0 device listing — confirm
   visually with Task Manager's NPU graph during rehearsal; long-context prefill (a genuinely full
   64K window) has not been latency-tested; ~15–16 tok/s decode means long replies take tens of
   seconds — keep agent replies terse via system prompt.

## Repro commands

```powershell
# server
& "$env:LOCALAPPDATA\GenieX CLI\geniex.exe" serve --nctx 65536 --compute npu

# tool-call smoke test
curl -s http://127.0.0.1:18181/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_0",
  "messages": [{"role":"user","content":"What is the temperature in rack B1?"}],
  "tools": [{"type":"function","function":{"name":"get_environmental_reading",
    "description":"Get temperature/humidity/leak status for a rack",
    "parameters":{"type":"object","properties":{"rack_id":{"type":"string"}},"required":["rack_id"]}}}],
  "max_tokens": 128}'
# expect: "finish_reason":"tool_calls" and a structured tool_calls array
```
