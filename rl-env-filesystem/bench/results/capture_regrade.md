# Benchmark: capture_regrade

15 rollouts, 15 succeeded.

## Delivery policies: modeled fetch + measured phases

| task | policy | upfront bytes | modeled fetch | lazy bytes | modeled lazy tail | measured task | reward |
| --- | --- | --- | --- | --- | --- | --- | --- |
| task_csv_report | hot_tier | 21.6 MB | 0.14s | 0.0 MB | 0.00s | 0.12s | 1.00 |
| task_grep_fix | hot_tier | 21.6 MB | 0.14s | 7.6 MB | 0.05s | 0.05s | 1.00 |
| task_numpy_solve | hot_tier | 21.6 MB | 0.14s | 0.0 MB | 0.00s | 0.53s | 1.00 |
| task_pandas_pipeline | hot_tier | 21.6 MB | 0.14s | 5.9 MB | 0.04s | 0.42s | 1.00 |
| task_sqlite_query | hot_tier | 21.6 MB | 0.14s | 0.5 MB | 0.00s | 0.08s | 1.00 |

## Capture and decoupled re-grade

| task | task time | capture time | checkpoint size | re-grade time | reward | re-grade reward |
| --- | --- | --- | --- | --- | --- | --- |
| task_csv_report | 0.12s | 0.035s | 0.1 MB | 0.022s | 1.00 | 1.00 |
| task_grep_fix | 0.05s | 0.009s | 0.0 MB | 0.016s | 1.00 | 1.00 |
| task_numpy_solve | 0.53s | 0.010s | 0.0 MB | 0.032s | 1.00 | 1.00 |
| task_pandas_pipeline | 0.42s | 0.016s | 0.0 MB | 0.035s | 1.00 | 1.00 |
| task_sqlite_query | 0.08s | 0.066s | 0.3 MB | 0.068s | 1.00 | 1.00 |
