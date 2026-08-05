## Whole-model latency vs context length (W4A16 bundle, HTP v73, burst)

| context | prefill 128-tok chunk (ms) | prefill tok/s | decode 1 tok (ms) | decode tok/s | parts |
|---|---|---|---|---|---|
| 512 | 259.3 ± 1.4 | 494 | 109.1 ± 0.7 | 9.2 | 4/4 |
| 1024 | 295.6 ± 1.1 | 433 | 123.4 ± 0.8 | 8.1 | 4/4 |
| 2048 | 368.5 ± 3.2 | 347 | 148.7 ± 1.2 | 6.7 | 4/4 |
| 3072 | 445.5 ± 2.3 | 287 | 177.1 ± 1.2 | 5.6 | 4/4 |
| 4096 | 503.6 ± 2.5 | 254 | 215.4 ± 1.6 | 4.6 | 4/4 |
