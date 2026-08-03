# Benchmark: concurrency_scale

48 rollouts, 48 succeeded.

## Delivery policies: modeled fetch + measured phases

| task | policy | upfront bytes | modeled fetch | lazy bytes | modeled lazy tail | measured task | reward |
| --- | --- | --- | --- | --- | --- | --- | --- |
| task_csv_report | hot_tier | 21.0 MB | 0.14s | 0.0 MB | 0.00s | 0.31s | 1.00 |
| task_numpy_solve | hot_tier | 21.0 MB | 0.14s | 0.0 MB | 0.00s | 1.55s | 1.00 |
| task_pandas_pipeline | hot_tier | 21.0 MB | 0.14s | 6.4 MB | 0.04s | 0.72s | 1.00 |
| task_sqlite_query | hot_tier | 21.0 MB | 0.14s | 0.6 MB | 0.00s | 0.18s | 1.00 |

## Capture and decoupled re-grade

| task | task time | capture time | checkpoint size | re-grade time | reward | re-grade reward |
| --- | --- | --- | --- | --- | --- | --- |
| task_csv_report | 0.31s | 0.094s | 0.1 MB | n/a | 1.00 | n/a |
| task_numpy_solve | 1.55s | 0.016s | 0.0 MB | n/a | 1.00 | n/a |
| task_pandas_pipeline | 0.72s | 0.026s | 0.0 MB | n/a | 1.00 | n/a |
| task_sqlite_query | 0.18s | 0.152s | 0.3 MB | n/a | 1.00 | n/a |

## Concurrency sweep (same rollout set per level)

| concurrency | batch wall clock | rollouts/min | task p50 | task p95 | mount p95 |
| --- | --- | --- | --- | --- | --- |
| 1 | 3.0s | 322 | 0.12s | 0.24s | 0.005s |
| 4 | 2.9s | 333 | 0.33s | 2.07s | 0.013s |
| 16 | 2.7s | 353 | 1.48s | 2.67s | 0.027s |
