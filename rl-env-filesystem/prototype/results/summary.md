# Repack and prefetch evaluation

Image: python:3.12-slim + synthetic deps layer. 7400 files, 213.0 MB uncompressed, 70.2 MB compressed.

## Access-based decomposition

| tier | files | uncompressed | compressed |
| --- | --- | --- | --- |
| hot (>=2 tasks) | 69 | 65.9 MB | 21.7 MB |
| warm (task_csv_report) | 0 | 0.0 MB | 0.0 MB |
| warm (task_grep_fix) | 1236 | 23.6 MB | 8.0 MB |
| warm (task_sqlite_query) | 1 | 1.6 MB | 0.8 MB |
| warm (task_numpy_solve) | 0 | 0.0 MB | 0.0 MB |
| warm (task_pandas_pipeline) | 50 | 18.2 MB | 6.1 MB |
| cold (never accessed) | 6044 | 103.7 MB | ~34.2 MB |

## Delivery policies: bytes before the agent can start

| policy | bytes fetched up front | lazy tail during rollout |
| --- | --- | --- |
| eager full pull (baseline) | 70.2 MB compressed | 0 |
| lazy, no prefetch | ~index only (KBs) | up to task working set |
| hot-layer prefetch | 21.7 MB | task's warm set |
| hot + profile prefetch (task_csv_report) | 21.7 MB | ~0 (profile hit) |
| hot + profile prefetch (task_grep_fix) | 29.7 MB | ~0 (profile hit) |
| hot + profile prefetch (task_sqlite_query) | 22.5 MB | ~0 (profile hit) |
| hot + profile prefetch (task_numpy_solve) | 21.7 MB | ~0 (profile hit) |
| hot + profile prefetch (task_pandas_pipeline) | 27.8 MB | ~0 (profile hit) |

## Leave-one-out: a NEW task arrives, prefetch from other tasks' profiles

| held-out task | accessed bytes | covered by prefetch | missed (lazy faults) | coverage |
| --- | --- | --- | --- | --- |
| task_csv_report | 11.1 MB | 11.1 MB | 0.0 MB | 100% |
| task_grep_fix | 29.5 MB | 6.8 MB | 22.7 MB | 23% |
| task_sqlite_query | 12.5 MB | 11.0 MB | 1.6 MB | 87% |
| task_numpy_solve | 63.5 MB | 63.5 MB | 0.0 MB | 100% |
| task_pandas_pipeline | 83.6 MB | 65.4 MB | 18.2 MB | 78% |

Reading: 'coverage' is how much of a never-before-seen task's working set the union of other tasks' profiles would have prefetched. The miss column is what a lazy filesystem would fault in on demand, i.e. the mid-rollout latency exposure.
