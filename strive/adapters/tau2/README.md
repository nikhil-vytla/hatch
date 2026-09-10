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
   seed/order, all memberships, and actual sizes against the 60/14/40 target.
   Selected-task grading or adaptive group-disjointness failure emits exact IDs
   and stops. See Amendment 3 modes below.
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

Milestone 8 supplies `scripts/install-tau2.sh` and the root `Containerfile` to
perform the preparation in Linux. The installer preserves the interpreter's
virtualenv path, installs the pinned telecom extra separately, retains the
original data and MIT notice, and copies the generated lock to
`.container-results/tau2-uv.lock`. `qualification_assertions.json` lists the
reviewed deterministic assertions from the pinned telecom tools; new functions
are rejected rather than automatically admitted.

`tests/vnext/test_tau2_live.py` now detects the installed distribution. Missing
tau2 skips; a wrong pin, incomplete data or failed qualification fails. Its
`live_checks` subprocess exercises real upstream evaluators, authored actor/user
responses, and process death after committed agent/user mutations without any
model calls. See `milestone8-container-verification/README.md` for the complete
build/verification command and current validation limits. The earlier macOS
installation note describes M5's result; it is not a reason to skip an installed
runtime in M8.

## Amendment 3 modes

Qualification now accepts `--mode adaptive` or `--mode fixed-stock`. Adaptive is
the default. It selects all base IDs and assigns whole base templates across our
own development/validation/audit split. The generator's `[mms_issue]`,
`[mobile_data_issue]`, and `[service_issue]` roots ignore appended failure-condition
combinations and persona tags. Shared goals or substrings never connect roots.
The closest allocation with three nonempty partitions is **49/29/36**, against
the 60/14/40 target. No selected ID is dropped. This split is Strive-derived and
has no leaderboard comparability claim.

The certificate retains source bytes, algorithm source, seed/order, group-to-ID
mapping, target/actual sizes, exact-target feasibility, and hard-gate outcomes.
Every selected headline task must pass strict deterministic grading and reference
execution. NL assertions, missing/unknown components and unreviewed assertions
still block. Our adaptive partition must cover the pool exactly once without
crossing groups. Full-inventory overlap across the stock train/test boundary is
informational under both the new roots and the historical connected-group rule.
The latter preserves the captured 2,285-ID diagnostic without blocking a valid
campaign. Unselected tasks receive a structural grading scan, reported separately;
only selected tasks receive executable initialization/reference checks.

Version 2 certificates explicitly bind the mode and extended report. The RPC
server requires a new Amendment 3 certificate rather than reinterpreting an old
certificate under different split semantics. Adaptive adapters declare
`development`, `validation`, and `audit`; fixed-stock adapters declare `test`.

The standalone fixed-stock runner executes an initial tau2 `llm_agent` with
unchanged model/options and a fresh actor per simulation. It has no refinement or
cross-episode memory path. This is an upstream LLM-agent baseline, not an opencode
actor port. Use an initial actor artifact prepared before examining results:

```json
{
  "schema": "strive.initial-tau2-actor/1",
  "agent": "llm_agent",
  "model": "gpt-4.1-2025-04-14",
  "model_settings": {"temperature": 0.0}
}
```

In the pinned Linux adapter environment:

```sh
adapters/tau2/.venv/bin/python -I -B -m strive_benchmark_tau2.fixed_stock \
  adapters/tau2/retained-data .container-results/fixed-stock \
  --initial-actor initial-actor.json --trials 4 --seed 300
```

This command makes model calls. Add `--prepare-only` to certify and retain the
plan without dispatch. The runner always pins the user simulator to
`gpt-4.1-2025-04-14` at temperature `0.0`, as in the pinned upstream defaults. It
retains the initial configuration, resolved upstream settings, task IDs, trials,
raw results and a separate `fixed-stock-result.json`. Missing rewards, missing
trials, duplicated task/trial identities and substituted tasks cannot produce a
completed result. A changed plan or existing result requires a fresh output
folder.

Fixed-stock results are comparable only to evaluations on the same stock `test`
population with matching settings. [Upstream split guidance](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/README.md)
identifies `base` as the original leaderboard denominator. Never label a 40-task
test score as a 114-task base leaderboard score, or combine it with adaptive
results. The whole-group rationale follows [GroupKFold](https://scikit-learn.org/stable/modules/cross_validation.html#group-k-fold).

The Linux verification script runs both certification modes and validates the
fixed runner's real upstream configuration without model calls. All five live
tau2 tests skip on macOS. The existing scorer-equivalence, mutation recovery,
jail and MultiToolMessage checks remain in place.
