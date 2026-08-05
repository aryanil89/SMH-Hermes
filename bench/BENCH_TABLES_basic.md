
## PREFILL (128-token chunk)

| part | graph slot | ops | latency mean±std (ms) | p50 | cold | HTP cycles (mean) | VTCM acq (µs) |
|---|---|---|---|---|---|---|---|
| part1 | 2 | 0 | 0.61 ± 0.06 | 0.60 | 2.99 | - | - |
| part2 | 5 | 0 | 154.39 ± 0.89 | 154.35 | 156.22 | - | - |
| part3 | 9 | 0 | 150.84 ± 1.42 | 150.38 | 153.91 | - | - |
| part4 | 8 | 0 | 197.74 ± 1.88 | 196.91 | 205.04 | - | - |
| **whole model (4 parts)** | | | **503.58 ± 2.52** | | | **0** | |

**128 token(s) per pass → 254.2 tok/s** (sum of graph execute times only; excludes Genie orchestration, KV-cache copies between parts, sampling)

Per-op hot spots (mean HTP cycles/inference):

- part1 (0 ops, Σ0 cyc): 
- part2 (0 ops, Σ0 cyc): 
- part3 (0 ops, Σ0 cyc): 
- part4 (0 ops, Σ0 cyc): 

## DECODE (1 token)

| part | graph slot | ops | latency mean±std (ms) | p50 | cold | HTP cycles (mean) | VTCM acq (µs) |
|---|---|---|---|---|---|---|---|
| part1 | 9 | 0 | 0.55 ± 0.02 | 0.55 | 3.04 | - | - |
| part2 | 4 | 0 | 68.78 ± 1.28 | 68.50 | 70.03 | - | - |
| part3 | 6 | 0 | 67.74 ± 0.36 | 67.67 | 70.28 | - | - |
| part4 | 4 | 0 | 78.30 ± 0.94 | 78.00 | 80.83 | - | - |
| **whole model (4 parts)** | | | **215.37 ± 1.63** | | | **0** | |

**1 token(s) per pass → 4.6 tok/s** (sum of graph execute times only; excludes Genie orchestration, KV-cache copies between parts, sampling)

Per-op hot spots (mean HTP cycles/inference):

- part1 (0 ops, Σ0 cyc): 
- part2 (0 ops, Σ0 cyc): 
- part3 (0 ops, Σ0 cyc): 
- part4 (0 ops, Σ0 cyc): 

## Init

Context load (all 4 parts, cold): **5.05 s**   ·   HVX threads: 4.0   ·   backend None
