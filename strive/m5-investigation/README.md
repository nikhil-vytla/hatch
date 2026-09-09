# Milestone 5 implementation report

M5 adds `strive.benchmark/1`, transactional benchmark operations, scoped admission,
suspended operator restoration, a bounded direct user-model adapter, and a
separately packaged telecom implementation. A second integer-target benchmark
runs through the same infrastructure. The implementation and deterministic
fixtures are reviewable; live tau2 qualification remains blocked by the local
installation/data limits below. No commits, history edits or PRs were made.

## Files and core changes

| Area | Files and purpose |
| --- | --- |
| M3 broker | `src/strive/vnext/runtime/broker.py` accepts pinned scoped policies alongside exact-hash grants. New `admission.py` retains rules and trusted artifact provenance. Argument, operand and candidate-view grants are distinct. |
| M3 supervisor | `runtime/supervisor.py` checks scoped candidate inputs, rejects candidate restoration, and provides atomic suspended operator restoration. It preserves explicit dispatch-stop errors. |
| M2 verifier | `verify/engine.py` recognizes only a retained `RestoreBundle` to a previously active bundle for the suspended exception. No state migration, result consumption, pending-command replacement or dispatch occurs. |
| M4 integration | New `harness/user_model.py` reuses the existing gateway capture, one-dispatch gate, bounds, usage and recovery. Existing gateway/provider/native-harness code is unchanged. |
| General benchmarks | `benchmarks/api.py`, `payloads.py`, `bridge.py`, `store.py`, `episodes.py`, `json_data.py`, `closure.py`. The API is the Amendment 2 Protocol. Payloads remain outside the authority codec. |
| Telecom | `adapters/tau2/` contains the pinned optional dependency, typed adapter/scorer, bounded RPC client/server, isolated native worker, data retention, qualification gate and certification entry point. |
| Second benchmark | `adapters/counter/` implements two integer-target tasks with bounded arithmetic and its own scorer. |
| Verification | New benchmark, qualification, user-model, purity, second-benchmark and live-certification tests under `tests/vnext/`. `pyproject.toml` adds both adapter source trees to strict mypy. |
| Documentation | Amendment 2 implementation status in `docs/ASTRA_DESIGN.md`, adapter READMEs, this report, `NOTES.md`, `_summary.md`, check outputs and core-freeze hashes. |

Frozen contracts, `codec._MODULES`, ledger and authority event families are
unchanged. Existing tests changed only as follows: the suspended-restoration
crash test now faults at `ACTIVATED` and asserts continued suspension; the broken
candidate sandbox test also requires suspension and unchanged state after
restoration; acceptance
uses the M5 driver, removes guarantee 4's xfail, and narrows guarantee 2's xfail
reason to protected-feedback noninterference. M4’s unchanged-core test retains
its historical hashes except for the three explicitly approved M5 runtime files,
which it checks against the new freeze. The fresh-interpreter helper now
also accepts completed benchmark histories and explicitly blocks adapter/heavy
imports. A vNext fixture blocks external Python network connections while
allowing the existing local gateway fixtures.

## Evidence and limits

A real subprocess RPC fixture also exercises remote discovery, operations and
scoring while blocking tau2/heavy imports. The execution composition root uses
the light client; the implementation, operation store and scorer run remotely.

The focused M5 suite exercises schema/scope/provenance/route/bound rejection,
transaction deduplication, changed request rejection, stale epochs, absent and
unknown lookup, corrupt receipts and missing state, state-supported reward,
communication/action boundary cases, and user-batch restart. Fixture scoring is
explicitly synthetic. It is not a claim that tau2's installed evaluators ran.

Guarantee 4 now passes for both agent and user mutations. Each probe commits a
real SQLite/CAS state change, crashes before the supervisor records its receipt,
reconciles once, then creates an unreconcilable model dispatch. Restoring the
prior bundle preserves environment, authorizations, pending effect, private
state, reservations and accounting; no retry occurs and execution stays
suspended. The standalone guarantee-2 probe rejects a counterfeit Measurement
at the producer port and returns zero for an unsolved state despite candidate
success claims. Its protected-feedback half remains strict-xfail. Guarantee 1's
native OS jail remains strict-xfail.

The second benchmark performs discovery, initialization, mutation, interruption,
lookup, scoring and fresh offline replay. `second-benchmark-core-freeze.json`
was captured before adding it. Its test compares those file hashes before and
after execution, covering supervisor, broker, ledger, verifier, frozen contracts,
codec and common benchmark infrastructure.

Fresh replay runs without an adapter environment and with our light adapter
wheel installed into an isolated directory but import-blocked. It rejects
corrupt state and receipt artifacts without decoding benchmark payloads, and
accepts bounded opaque annotations. The installation test uses a small purelib
wheel installer because uv's offline installer also panics here. The tau2
transitive environment itself has not been installed.

## Task qualification and upstream status

The full upstream inventory scan did **not** run. No upstream task IDs are
excluded or certified. The gate scans every supplied inventory record and every
declared split, checks unique/resolved IDs and the disjoint 74/40 union, joins
persona-stripped scenario and normalized init/goal equivalences transitively,
rejects train/audit crossings, and partitions exactly 60/14 by whole groups with
a retained deterministic order. Fixtures cover non-base ineligible tasks,
required NL/unknown grading, unqualified assertions, reference-action failures,
crossing groups and impossible partitions. Failures expose exact affected IDs
and a revised-campaign proposal without changing criteria or denominator.

The dependency is pinned to [tau2 commit a2c0247](https://github.com/sierra-research/tau2-bench/tree/a2c024725189473d2d7cea3a5cfdbcc67478e41f),
distribution 1.0.1, MIT. `uv lock --project adapters/tau2` failed before resolution
with macOS system-configuration's `Attempted to create a NULL object` panic.
Shell retrieval failed DNS for `raw.githubusercontent.com`; the web reader
rejected the full task JSON as larger than 4MB. No lockfile or resolved closure
was invented. Three live tests are explicitly skipped with those reasons.
The adapter README gives the installation, retention and certification sequence.

## Decisions and M6 prerequisites

Operator restoration is authenticated through the existing supervisor-owned
activation record; it adds no wire producer or event family. Missing operation
rows produce absence evidence only in a complete, fenced store. An absence
proof closes the attempt without an implicit retry. Extra user-model settings
and unsupported provider behavior fail explicitly; native actor/refiner tools
remain disabled. Snapshot reconstruction suppresses constructor synchronization
so a failed tool's committed state cannot change merely by reopening it.

Before a live adaptation campaign, complete the isolated dependency closure,
review the assertion allowlist, run full-inventory qualification and the skipped
upstream-equivalence tests. M6 must then build the trusted adaptation controller:
scoped proposal staging, compatible bundle validation, isolated fork evaluation
with explicit snapshot origins, comparison evidence, and activation only at a
legal boundary. Preserve the fixed campaign, protected feedback rules and
pending obligations. Protected-feedback noninterference remains a later
research-workflow acceptance obligation.

## Check results

- Strict mypy: clean across 134 files.
- Final focused M5 suite: 59 passed, 3 skipped.
- Existing core and acceptance run: 108 passed, 2 intended xfails.
- Full repository run: 655 passed, 9 skipped, 3 xfailed. Its four failures were
  the two known `uv build` macOS panics and the two old assertions described
  above. Both assertion updates then passed in `updated-prior-tests.txt`.
  The full 13-minute run was not repeated after these test-only corrections;
  only the two pre-existing packaging failures remain unresolved.

See `mypy-final.txt`, `m5-final-tests.txt`, `core-and-probes.txt`, and
`pytest-full.txt` for retained command outputs. Commands use the existing
virtualenv with `UV_CACHE_DIR=/tmp/strive-m5-uv-cache`, `UV_NO_SYNC=1` and
`UV_OFFLINE=1`; no dependency update or model call is part of testing.
