
## PREFILL (128-token chunk)

| part | graph slot | ops | latency mean±std (ms) | p50 | cold | HTP cycles (mean) | VTCM acq (µs) |
|---|---|---|---|---|---|---|---|
| part1 | 2 | 1 | 0.77 ± 0.09 | 0.75 | 3.42 | 29,287 | 268 |
| part2 | 5 | 8088 | 580.99 ± 9.59 | 576.75 | 1154.60 | 215,356,974 | 542 |
| part3 | 9 | 8088 | 547.35 ± 8.45 | 544.95 | 1071.52 | 213,674,964 | 537 |
| part4 | 8 | 8092 | 659.47 ± 9.71 | 655.31 | 1433.92 | 233,973,747 | 534 |
| **whole model (4 parts)** | | | **1788.58 ± 16.05** | | | **663,034,972** | |

**128 token(s) per pass → 71.6 tok/s** (sum of graph execute times only; excludes Genie orchestration, KV-cache copies between parts, sampling)

Per-op hot spots (mean HTP cycles/inference):

- part1 (1 ops, Σ24,724 cyc): `node_embedding` 24,724
- part2 (8088 ops, Σ214,897,718 cyc): `node_silu_10` 833,661, `node_silu_11` 826,646, `node_silu` 824,603, `node_silu_8` 824,191
- part3 (8088 ops, Σ213,198,867 cyc): `node_silu_22` 827,807, `node_silu_23` 826,084, `node_silu_17` 818,177, `node_silu_21` 817,506
- part4 (8092 ops, Σ220,565,317 cyc): `node_linear_72` 10,701,650, `node_silu_35` 829,073, `node_silu_27` 824,956, `node_silu_26` 823,702

## DECODE (1 token)

| part | graph slot | ops | latency mean±std (ms) | p50 | cold | HTP cycles (mean) | VTCM acq (µs) |
|---|---|---|---|---|---|---|---|
| part1 | 9 | 1 | 0.68 ± 0.04 | 0.66 | 3.41 | 1,662 | 269 |
| part2 | 4 | 8064 | 468.07 ± 10.01 | 467.63 | 959.81 | 87,112,064 | 549 |
| part3 | 6 | 8064 | 463.71 ± 6.96 | 461.75 | 935.50 | 87,750,809 | 546 |
| part4 | 4 | 8067 | 511.60 ± 15.30 | 504.65 | 1152.66 | 91,947,392 | 548 |
| **whole model (4 parts)** | | | **1444.06 ± 19.56** | | | **266,811,927** | |

**1 token(s) per pass → 0.7 tok/s** (sum of graph execute times only; excludes Genie orchestration, KV-cache copies between parts, sampling)

Per-op hot spots (mean HTP cycles/inference):

- part1 (1 ops, Σ964 cyc): `node_embedding` 964
- part2 (8064 ops, Σ86,958,053 cyc): `node_linear_20` 259,578, `node_linear_18` 258,917, `node_linear_6` 258,721, `node_linear` 258,651
- part3 (8064 ops, Σ87,600,784 cyc): `node_linear_34` 255,403, `node_linear_38` 253,449, `node_linear_40` 252,931, `node_linear_42` 252,905
- part4 (8067 ops, Σ91,773,389 cyc): `node_linear_72` 6,034,936, `node_linear_48` 230,458, `node_linear_69` 230,401, `node_linear_56` 227,652

## Init

Context load (all 4 parts, cold): **5.34 s**   ·   HVX threads: 4.0   ·   backend None
