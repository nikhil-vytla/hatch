# Core freeze baselines

`core-baseline.json` retains the original 21-file harness baseline.
`second-benchmark-core-freeze.json` pins the current 30-file core, including the
benchmark layer. Paths are relative to the project root; values are SHA-256
hashes of exact file bytes.

The harness test asserts that the historical-to-current difference is exactly:

- `src/strive/vnext/runtime/broker.py`
- `src/strive/vnext/runtime/supervisor.py`
- `src/strive/vnext/verify/engine.py`
- `src/strive/vnext/contracts/manifest.py`
- `src/strive/vnext/contracts/__init__.py`

The first three changes cover scoped admission and suspended operator
restoration. The manifest change limits telemetry to the reference profile.
The initializer change only redirects its docstring to
[ARCHITECTURE.md](../../../docs/ARCHITECTURE.md). That pointer update is explicitly
approved; no initializer logic changed. Its current hash was regenerated while
the historical manifest stayed byte-for-byte intact.

Readers are `test_core_freeze_all_30_hashes_match` in `test_adaptation.py`,
`test_core_unchanged_and_adapters_selected_by_manifest` in `test_harness.py`, and
`test_second_benchmark_zero_core_diff_discovery_operations_scoring_recovery` in
`test_second_benchmark.py`. The current hashes are checked before and after the
second benchmark's operation/recovery exercise. Relocation preserves those
assertions. Do not refresh unrelated entries to make a drift failure disappear.
