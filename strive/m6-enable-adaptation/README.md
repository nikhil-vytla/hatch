# M6: enable adaptation

M6 adds a continual-refine policy above the frozen supervisor, broker, sandbox, gateway and benchmark APIs. The counter campaign runs under the active bundle, obtains a brokered refiner proposal, atomically activates a complete revision, and continues operating. In the deterministic two-episode acceptance case, a prompt edit changes the trusted success measurement from 0 to 1. No live model calls, spend, commits, PRs or git history changes were made.

## Implementation

| New file | Responsibility |
|---|---|
| [`policy/data.py`](../src/strive/vnext/policy/data.py) | Versioned bundle, file, dependency, provenance and proposal payloads behind CAS references. These do not extend frozen record or command contracts. |
| [`policy/bundles.py`](../src/strive/vnext/policy/bundles.py) | Complete bundle construction; structure, dependency, capability, editable-scope and expected-revision validation; durable compatibility registry. |
| [`policy/evidence.py`](../src/strive/vnext/policy/evidence.py) | Intersects trusted pool assignments, feedback A/B and broker read grants before constructing context. |
| [`policy/refiner.py`](../src/strive/vnext/policy/refiner.py) | Refiner GenerationInput admission and proposal decoding through the existing ModelGateway. Reservations, forwarding, receipts and reconciliation use the existing authority path. |
| [`policy/sandbox.py`](../src/strive/vnext/policy/sandbox.py) | Loads the entire active bundle into one bounded CandidateSandbox invocation. Actor and controller code execute inside Deno, with literal file bytes and supplied dependency sources. |
| [`policy/runtime.py`](../src/strive/vnext/policy/runtime.py) | Episode scheduling, refinement intervals, keep/revise/restore/gather-more-evidence decisions, optional development checks and recovery. |
| [`policy/__init__.py`](../src/strive/vnext/policy/__init__.py) | Public policy API. |
| [`adaptation_fixtures.py`](../tests/vnext/adaptation_fixtures.py) | Offline composition of the counter adapter, Deno, ModelGateway, broker and scripted upstream. |
| [`test_adaptation.py`](../tests/vnext/test_adaptation.py) | Deterministic M6 acceptance tests and the single deferred fork test. |

This folder retains the investigation notes, report, summary, checks and a patch containing only the new implementation/test files. It contains no fetched repository or vendored dependency. The previous stopped investigation in `m6-adaptation/` is untouched.

## Composition and operation

Create a `BundleManager` using the run's exact editable scope, supplied dependency sources and capability names. Its `initial()` method retains the starting files. Bind the manager to the verified reader, pass `manager.compatible` to `Supervisor`, and wrap the existing `DenoSandbox` with `BundleSandbox`. Create `ScopedAdmission` rules for the benchmark operations and refiner generation, with `GenerationValidator` and the existing operation validator. Capability requests in a bundle remain requests; the broker still authorizes every effect independently.

`ContinualRefine.run()` takes an existing BenchmarkAdapter, episode assignments, operation routes and a pinned `EpisodeProgram` translator. The controller uses the fixed step interface and produces a canonical Continue with action bytes in its private state; the translator creates ordinary benchmark requests. This separation keeps benchmark semantics outside the verifier and policy bundle loader. The general `BundleSandbox` also works directly with `Supervisor.step()` and its canonical command interface.

`GatewayRefiner` accepts the existing ModelGateway, whose Upstream is injectable. It checks the refiner model against the retained RunBinding and emits the existing GenerationInput with role REFINER and calls `model.generate` through ExecuteEffect. It supports the gateway's pinned Responses and Anthropic text contracts. The policy decoder is separate because M4's native text harness decoder currently expects an ExecuteEffect proposal. No change to that decoder or the gateway was needed. Tests exercise this gateway path with a scripted upstream, exact model identity, retained requests and receipts, and zero prices.

A comparison request with no development callback proceeds to activation. A supplied development callback is a trusted, pure policy check; any external evaluation effects must use the broker. Its rejection chooses more evidence. Rationales and claims of improvement are retained annotations and never grant activation authority.

## Atomic revisions and controller handover

Every bundle contains the complete path-to-file-version mapping, declared dependencies, requested capabilities and fixed step interface version. CAS objects are published before a compatibility approval or activation command. A durable registry records which complete bundles passed trusted validation, including the exact ApplyChange and its controller-state reference. The supervisor's existing RevisionActivation remains the authority for the active revision.

Editable paths map to `actor.code`, `actor.prompts`, `actor.memory` and explicitly enabled `controller.code`. `skills/` uses the memory permission. The default reference fixture omits controller editing. Dependencies must already exist in the supplied pinned environment; there is no dependency installer or candidate-created privileged adapter.

A controller change requires an empty command/result boundary and explicit initial private-state bytes. The new bundle and state commit together. The compatibility callback also rejects a stripped state reference before activation. Crashing, looping and invalid controllers fail within Deno's existing bounds and suspend through the supervisor. Operator restoration uses the M5 `Supervisor.restore()` durable command path without running candidate code; it preserves environment, accounting, result cursors and suspension. Suspended restoration retains private state and does not claim general state migration or automatic resume.

The refiner context includes the active bundle and previously active bundle IDs, so restore proposals can choose a target from authorized history metadata. Recovery uses retained model effects and committed continuations to avoid repeated generation. A committed actor action is reused after restart before its operation is accepted. The tests cover interruptions after model return, recorded return, settlement, accepted activation and committed activation.

## Memory, provenance and feedback

Memory and skills are ordinary immutable versioned files, without a required ontology. Each FileVersion retains its content reference, previous version, exact access scope and source origins. Changed files preserve prior origins. Refiner-produced files also retain the exact authorized evidence used by that generation, the active files' origins and the captured proposal response. A summary cannot discard validation provenance. Binary memory stays unchanged in CAS and uses base64 when projected into text-only refiner context.

Imports must name an already admitted file version in the same scope. They retain the imported source and all its origins. Possessing an arbitrary CAS digest or submitting a claimed scope does not admit a file, and cross-scope/protected imports are rejected. All components of a revision are loaded from one bundle reference, so a prompt, code and memory update cannot be observed as a mixture of revisions.

Contract A admits granted development evidence and permitted operational failures. Contract B additionally admits explicitly granted validation evidence. Operational outputs require a trusted benchmark episode-pool assignment and a broker-visible output grant. A validation output cannot become development evidence by being called an operational observation. Audit/private pools, hidden environment snapshots, receipts and scorer evidence do not enter the refiner context implicitly. M7's full campaign-level protected-feedback noninterference acceptance case remains separate work.

## Test-to-behavior map

All names below are in `tests/vnext/test_adaptation.py`. Parameterized cases are counted separately.

| Test | Cases | Behavior |
|---|---:|---|
| `test_prompt_only_edit_changes_behavior` | 1 | Prompt edit changes the next bounded step's delta from 1 to 7. |
| `test_code_only_edit_changes_behavior` | 1 | Actor code edit changes delta from 1 to 7 with the same prompts and memory. |
| `test_memory_write_persists_and_is_readable_next_episode` | 1 | Memory and freeform skills persist across restart and episodes; previous bytes and provenance remain readable. |
| `test_composite_activation_crash_is_atomic` | 2 | Code, prompt and memory changes recover across accepted/activated faults to one complete revision. |
| `test_restore_preserves_environment_and_accounting` | 1 | Restoration changes the bundle while preserving current environment, effects, spending, obligations, cursors and private state. |
| `test_invalid_proposal_rejected_without_activation` | 6 | Rejects scope, revision, dependency, capability, missing entrypoint and traversal-path violations without changing verified state. |
| `test_controller_edit_rejected_out_of_scope` | 1 | The reference scope pins the controller. |
| `test_bounded_controller_handover_is_atomic` | 2 | Controller and explicit initial state activate atomically through both crash boundaries; supervisor identities, cursors and accounting survive. |
| `test_broken_controller_suspends_operator_restores_without_execution` | 3 | Crash, loop and invalid output cause bounded failure and suspension; operator restores without another candidate invocation. |
| `test_handover_rejects_pending_command_and_unconsumed_result` | 1 | Both forbidden handover boundaries reject construction. |
| `test_continual_refine_counter_replay_and_fresh_interpreter_purity` | 1 | Operate, refine, activate and continue; trusted scores 0 then 1; exactly one model call; restart does not repeat effects; fresh read-only replay forbids policy/candidate/benchmark/heavy imports and dispatch. |
| `test_refiner_policy_decisions` | 3 | Keep, gather-more-evidence and restore decisions recover without another model call. |
| `test_evidence_intersects_feedback_and_grants_before_read` | 2 | A/B selection excludes audit, private and ungranted artifacts. |
| `test_memory_import_cannot_launder_provenance_or_scope` | 1 | Forged protected file versions and scope-widening derived memory are rejected. |
| `test_core_freeze_all_30_hashes_match` | 1 | All 30 M5 frozen hashes match. |
| `test_evaluate_fork_enactment_deferred` | 1 xfail | Explicitly tracks the approved deferral described below. |
| `test_refiner_crash_recovery_never_repeats_generation` | 4 | External return, recorded return, settlement and activation interruptions retain exactly one model call and one new revision. |
| `test_development_check_is_optional_and_can_gather_more_evidence` | 1 | An optional local check can defer; removing it permits immediate activation with forks unsupported. |
| `test_validation_provenance_survives_summary_and_import` | 1 | Validation origins survive model-derived memory and a subsequent skill-file import. |
| `test_validation_operation_observation_does_not_become_development` | 2 | A excludes a validation operation projection; B includes it with its original pool. |
| `test_actor_action_is_not_rerun_after_committed_step_crash` | 1 | Restart uses the recorded action instead of executing the actor again. |
| `test_stripping_handover_state_cannot_activate` | 1 | An altered accepted command cannot activate the approved controller without its state. |
| `test_refiner_must_match_retained_model_binding` | 1 | Rejects a refiner model that differs from RunBinding before dispatch. |
| `test_binary_memory_is_retained_as_file_data_in_refiner_context` | 1 | Arbitrary binary memory remains a file and projects to text context without loss. |
| `test_open_annotation_payload_cannot_break_policy_decision_lookup` | 1 | An opaque annotation with the policy namespace cannot break decision recovery. |

## Verification

The final full vNext invocation passed **411 tests, with 10 skipped and 4 xfailed, in 642.03 seconds**. The four xfails are the unchanged three existing cases plus the one new deferred fork test. The focused acceptance run passed **40 tests with 1 xfailed**; the final context-based restoration recheck passed all three decision cases. After the full suite, `uv run mypy --strict` passed across **143 source files**. Project mypy configuration is also strict by default.

Retained output: [`pytest-vnext-final.txt`](pytest-vnext-final.txt), [`pytest-focused.txt`](pytest-focused.txt), [`pytest-restore.txt`](pytest-restore.txt), and [`mypy-final.txt`](mypy-final.txt).

The final full-suite command is:

```sh
TMPDIR="$PWD/m6-enable-adaptation/.tmp" \
UV_NO_SYNC=1 UV_OFFLINE=1 UV_CACHE_DIR="$PWD/m6-enable-adaptation/.uv-cache" \
uv run pytest tests/vnext -q --tb=short --basetemp=m6-enable-adaptation/.pytest-tmp
```

`core-integrity.json` records all 30 matching hashes. `core.diff` is empty for every frozen path and `harness/gateway.py`. No existing source or test file was modified; legacy code remains intact. Fresh-interpreter replay in the M6 counter acceptance test excludes every non-allowlisted strive module, including all new policy code.

## Deferred fork status

EvaluateFork enactment remains **unsupported**, exactly as declared by the existing adapters. There is one new strict xfail, `test_evaluate_fork_enactment_deferred`. Its reason says a future approved verifier+supervisor change must authorize and charge fork effects, because **ExecuteEffect is currently the only chargeable authorization**. No alternate fork effect, isolated environment constructor, free comparison or verifier bypass was added. The policy's immediate-activation path is fully exercised without forks.

## M7 priorities

1. Resolve and retain manifests/studies, enforce campaign-wide A/B grants and audit embargoes, and close the protected-feedback noninterference acceptance case.
2. Add restart-safe study expansion, phase allocations, selection/freeze state and complete coverage/denominator reporting.
3. Build traceable comparison reports and CLI inspection, then journal-derived telemetry with outage/re-export tests.
4. Qualify the production confinement floor and funded reference workflow. Revisit fork enactment only through a separately approved core change and an adapter with actual fork support.
