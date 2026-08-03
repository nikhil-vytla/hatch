# Benchmark: delivery_policies

25 rollouts, 25 succeeded.

## Delivery policies: modeled fetch + measured phases

| task | policy | upfront bytes | modeled fetch | lazy bytes | modeled lazy tail | measured task | reward |
| --- | --- | --- | --- | --- | --- | --- | --- |
| task_csv_report | eager_full | 70.2 MB | 0.47s | 0.0 MB | 0.00s | 0.22s | 1.00 |
| task_csv_report | hot_tier | 21.6 MB | 0.14s | 0.0 MB | 0.00s | 0.12s | 1.00 |
| task_csv_report | lazy_none | 0.3 MB | 0.00s | 3.7 MB | 0.02s | 0.21s | 1.00 |
| task_csv_report | profile | 21.6 MB | 0.14s | 0.0 MB | 0.00s | 0.12s | 1.00 |
| task_csv_report | profile_loo | 35.7 MB | 0.24s | 0.0 MB | 0.00s | 0.12s | 1.00 |
| task_grep_fix | eager_full | 70.2 MB | 0.47s | 0.0 MB | 0.00s | 0.05s | 1.00 |
| task_grep_fix | hot_tier | 21.6 MB | 0.14s | 7.6 MB | 0.05s | 0.07s | 1.00 |
| task_grep_fix | lazy_none | 0.3 MB | 0.00s | 9.9 MB | 0.07s | 0.05s | 1.00 |
| task_grep_fix | profile | 29.3 MB | 0.20s | 0.0 MB | 0.00s | 0.07s | 1.00 |
| task_grep_fix | profile_loo | 28.0 MB | 0.19s | 7.6 MB | 0.05s | 0.05s | 1.00 |
| task_numpy_solve | eager_full | 70.2 MB | 0.47s | 0.0 MB | 0.00s | 1.98s | 1.00 |
| task_numpy_solve | hot_tier | 21.6 MB | 0.14s | 0.0 MB | 0.00s | 1.92s | 1.00 |
| task_numpy_solve | lazy_none | 0.3 MB | 0.00s | 20.7 MB | 0.14s | 1.93s | 1.00 |
| task_numpy_solve | profile | 21.6 MB | 0.14s | 0.0 MB | 0.00s | 1.85s | 1.00 |
| task_numpy_solve | profile_loo | 35.7 MB | 0.24s | 0.0 MB | 0.00s | 0.88s | 1.00 |
| task_pandas_pipeline | eager_full | 70.2 MB | 0.47s | 0.0 MB | 0.00s | 0.39s | 1.00 |
| task_pandas_pipeline | hot_tier | 21.6 MB | 0.14s | 5.9 MB | 0.04s | 0.55s | 1.00 |
| task_pandas_pipeline | lazy_none | 0.3 MB | 0.00s | 27.2 MB | 0.18s | 0.52s | 1.00 |
| task_pandas_pipeline | profile | 27.5 MB | 0.18s | 0.0 MB | 0.00s | 0.42s | 1.00 |
| task_pandas_pipeline | profile_loo | 29.8 MB | 0.20s | 5.9 MB | 0.04s | 0.37s | 1.00 |
| task_sqlite_query | eager_full | 70.2 MB | 0.47s | 0.0 MB | 0.00s | 0.08s | 1.00 |
| task_sqlite_query | hot_tier | 21.6 MB | 0.14s | 0.5 MB | 0.00s | 0.08s | 1.00 |
| task_sqlite_query | lazy_none | 0.3 MB | 0.00s | 4.1 MB | 0.03s | 0.08s | 1.00 |
| task_sqlite_query | profile | 22.1 MB | 0.15s | 0.0 MB | 0.00s | 0.08s | 1.00 |
| task_sqlite_query | profile_loo | 35.2 MB | 0.23s | 0.5 MB | 0.00s | 0.07s | 1.00 |
