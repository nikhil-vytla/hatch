# Isolated tau2 adapter

This project implements `strive.benchmark/1` for the telecom text workload pinned
to `a2c024725189473d2d7cea3a5cfdbcc67478e41f`. Its `telecom` extra is a direct Git
reference to `tau2` 1.0.1. Do not install that extra in strive's runtime or verifier
interpreter. `native_worker.py` runs only through a separate interpreter; all
cross-process values are JSON bytes. Actor/controller code stays in its existing
bounded sandbox.

Resolution has not succeeded in this workspace. `uv lock` panics in macOS
system-configuration before resolving packages. No lockfile, installed tau2
closure, full inventory certificate or live-equivalence result is claimed.
`tests/vnext/test_tau2_live.py` records those limits as explicit skips.

Preparation must complete these steps before live dispatch:

1. Resolve `uv lock` and `uv sync --extra telecom` inside this project in an
   environment that can access the pinned source. Retain every dependency wheel,
   the upstream source/wheel, Python/platform/build identities, and licenses.
2. Install strive's dependency-light vNext code in the adapter interpreter
   without pulling in the legacy DSPy runtime. Retain that code identity too.
3. Retrieve the full original telecom task/split bytes and all loaded databases,
   policies and simulator guidelines. Preserve the upstream MIT copyright and
   permission notice alongside redistributed artifacts. `retain_data()` creates
   a read-only data tree and hashes its original bytes.
4. Supply a reviewed `qualification_assertions.json` mapping requestors to
   deterministic assertion-function names. Run `python -m
   strive_benchmark_tau2.certify DATA_ROOT OUTPUT_ROOT`. It executes strict
   initialization/reference checks without inference and retains grouping,
   seed/order, all memberships and the 60/14/40 result. Failure emits exact IDs
   and a revised-campaign proposal, then stops.
5. Retain the full closure through `benchmarks.closure`, construct
   `IsolatedTau2(python, data_root, objects, closure, data_index)`, derive
   `implementation_identity()`, and create the operation store with that identity
   and the current supervisor epoch in the isolated adapter runtime. Build
   `Tau2Adapter` there from the qualified task records.
6. The execution composition root uses `client.Tau2Client`, which implements the
   same protocol over bounded one-shot RPC. Its retained configuration contains
   CAS/store paths, run/epoch, closure, data-index and qualification-report
   references. Only initial setup may bootstrap a new operation store. Resume
   supplies the new lease epoch and opens the existing store; it never creates a
   replacement store for missing history. The implementation, SQLite store and
   scorer execute in the adapter process. The worker uses the same pinned
   adapter interpreter for upstream calls.

The native worker uses upstream `get_response()` for tool execution and runs
`UserSimulator.generate_next_message()` with its generation function intercepted.
Planning captures the actual role-flipped structured request; response commit
injects a separately captured model reply. Tool proposals become separate broker
effects. The common episode driver authenticates the model cursor and resumes
pending batches from committed receipts. No prose parser or hidden model call is
used.

Scoring checks both databases against strict replay, evaluates the committed
state on a copy, and compares the deterministic upstream evaluator outcome.
`Action.compare_with_tool_call` is called upstream unchanged. Requestor authority
is enforced by operation admission and execution, separately from its metric.
Missing, NL or unknown required grading stops qualification. Infrastructure
inconsistency produces an invalid/unresolved result with no success metric.
