Milestone 3 adds effect execution, accounting and candidate confinement under
`src/strive/vnext/runtime/`. M1 contracts and the M2 verifier, codec, wire format,
CAS and journal are unchanged. Every authority append uses M2's leased producer
port, which preflights the current verified prefix before committing. No commit
or PR was created.

The supervisor accepts canonical `StepOutput` bytes before acting on their
command, authorizes and reserves before dispatch, records returns separately
from settlement, and consumes results with private state and the next command
in one continuation. A lock rejects concurrent or reentrant execution; the M2
lease and epoch fence other writers and stale returns. All effect identities
are assigned by the supervisor. Accounting reads `VerifiedState`, so restart
cannot reset a mutable balance or count a reservation twice.

`CapabilityBroker` uses a retained policy bound by `RunBinding.capabilities`.
M3 grants match exact binding, operation, destination, scope, argument artifact
and input handles. The trusted adapter supplies a defensible reservation and
cumulative measurements. Candidate annotations never establish expenditure.
Partial receipts replace known components while retaining unknown obligations;
a real overrun is recorded even above the run limit and stops dispatch.
`Receipt` is a trusted adapter interface, never a candidate input port.

`EffectAdapter.prepare` performs no paid work. `invoke` receives a
`DispatchContext`; `reconcile` may establish an outcome only under its pinned
recovery contract. Its one-use `forward` callback validates and retains the
actual request and commits the upstream-stage authorization before calling the
send function. Repeated forwarding is rejected. This is an in-process adapter
boundary, not a qualified network gateway or an implementation of the external
harness launch protocol.

Candidate execution uses `Supervisor.step(sandbox, artifacts)`. M3 bundles are
ECMAScript source defining `step(view, private_state, recorded_result, handles)`;
the arguments and returned `StepOutput` use M2's tagged JSON representation.
The fourth argument supplies only copied, scoped bytes indexed by content hash.
It adds no authority or alternative command schema. The parent validates the
returned frozen types and owns the result cursor. Python candidate execution
is not implemented by this profile.

To account for the sandbox itself without violating M2's serial-effect rule,
a continuation consumes the preceding result into a pending supervisor-owned
`runtime.step` command containing that exact result as input. The supervisor
reserves wall milliseconds, invokes the confined step, retains its output,
settles measured time, and consumes that output with the proposed private state
and command. An interrupted step with no durable return suspends and retains
its reservation. It is never silently recomputed. `@supervisor` and
`runtime.step` cannot be requested by a candidate. The bound profile and all
resource settings must match on resume and subsequent steps.

Recovery reuses durable returns, settles incomplete bookkeeping, and restores
committed continuations. Authorization without a return is potentially
performed even when there is no dispatch marker. Supported adapter lookup can
recover the original outcome; unsupported ambiguity suspends without releasing
its reservation. Business deduplication alone cannot authorize paid retry.
Late receipts can adjust accounting after `Finish`, but cannot change the
response, environment, consumed cursor or finished status. The fake service
lives independently of the restarted supervisor; its mutation counter verifies
that recovery does not perform an operation twice. Qualification of a real
transactional workload remains a later milestone.

`Supervisor.restore` accepts `RestoreBundle` through the same durable command
path and invokes a trusted compatibility validator. It does not run the broken
candidate. Restoration preserves measured usage, obligations, environment and
consumed cursors. It obeys M2's legal activation boundary: it cannot discard an
ambiguous effect, bypass a pending command, or resume dispatch after an overrun.
Full bundle closure validation and broader adaptation/fork behavior remain in
the adaptation and stateful-operation milestones; `EvaluateFork` fails closed.

Confinement on this host is explicit:

| Control | Implemented enforcement |
|---|---|
| Credentials, authoritative storage, protected evidence | Deno denies host reads/writes and environment access. The child receives a scrubbed environment and copied scoped inputs. |
| Network, tools, native code | Deno denies network, subprocess, FFI, system and remote-import permissions. Runtime imports and worker imports are checked. |
| Initial import-graph exception | A trusted import-free bootstrap is the entry module. Candidate source is dynamically compiled from input after permissions apply. |
| Process resources | Hard POSIX CPU, descriptor, per-file-size and zero-core limits; a parent wall watchdog; bounded combined stdout/stderr capture; V8 heap cap; RSS watchdog using Darwin `proc_pidinfo` or Linux `/proc`. |
| Files and lifetime | Closed inherited descriptors, fresh disposable cwd/cache, no candidate host filesystem grant, and process-group termination on completion or failure. |
| Identity | Profile records executable/bootstrap/launcher/runtime/monitor hashes and every resource setting. Resume rejects profile changes. Run setup still owns the retained trusted dependency closure. |
| Deferred production floor | Hard whole-process allocation limit, aggregate disk quota, and an OS jail for arbitrary native harness process trees. RSS polling and a V8 heap limit do not establish these guarantees. |

This Mac has Deno 2.9.5. `sandbox-exec` is present but applying its profile fails
with `sandbox_apply: Operation not permitted` in this managed session. A usable
Seatbelt profile plus hard memory/storage enforcement, or a quota-controlled
container/VM, is required for the production floor. The implementation never
falls back to unrestricted CPython. The production-floor test is strict-xfail;
the implemented permission attacks are passing tests. Deno's documented
[permissions](https://docs.deno.com/runtime/reference/permissions/) and
[initial-module exception](https://docs.deno.com/runtime/fundamentals/security/)
informed the bootstrap design.

Files created:

| Files | Purpose |
|---|---|
| `src/strive/vnext/runtime/supervisor.py` | Durable lifecycle, sandbox accounting, fault hooks, serial execution, recovery, restoration. |
| `src/strive/vnext/runtime/broker.py`, `ledger.py` | Pinned capabilities, adapter/receipt boundary, upstream gate, admission and settlement. |
| `src/strive/vnext/runtime/sandbox.py`, `_candidate.js`, `_limits.py`, `_memory.py`, `__init__.py` | Candidate profile/interface, confined runner, limits, memory sampling and exports. |
| `tests/vnext/runtime_fixtures.py` | Independent trusted fake service and bound runtime fixture. |
| `tests/vnext/test_runtime.py`, `test_runtime_sandbox.py` | Fault injection, accounting, restoration and actual candidate attacks. |
| `milestone3-effects/NOTES.md`, `README.md`, `_summary.md`, `.gitignore`, `existing-files.diff` | Investigation notes, report, concise summary and review support. Generated test/cache files are ignored. |

Existing changes are limited to the vNext README and the reasons on acceptance
probes 1 and 3. No legacy modules or tests were deleted. The report directory
contains no fetched repositories or copied third-party sources.

Each required case maps to an executable test:

| Case | Test in `tests/vnext/` |
|---|---|
| Accepted request, authorization, dispatch, external return before journaling, return before settlement, settlement before continuation | `test_runtime.py::test_crash_and_recover_every_effect_boundary` |
| Atomic result consumption and next pending command; no duplicate effect/spend | `test_continuation_consumes_result_and_next_command_atomically` |
| Ambiguous performed mutation; reservation retained | `test_unsupported_ambiguity_retains_reservation_even_after_real_mutation` |
| Lookup recovers original mutation once | `test_crash_and_recover_every_effect_boundary[external_return]` |
| Business deduplication is insufficient for billing | `test_business_deduplication_does_not_authorize_paid_retry` |
| Launch/upstream-stage authorization and return/settlement crashes | `test_upstream_stage_crash_recovery` |
| Request, epoch and reservation durable inside dispatch; reentrant dispatch blocked | `test_durable_request_and_reservation_exist_inside_dispatch` |
| Hidden second upstream request denied | `test_in_process_upstream_gate_retains_actual_request_and_denies_second` |
| Destination, scope, operation, arguments, input and binding attacks | `test_broker_rejects_unauthorized_requests` |
| Stale epoch and stale step/head | `test_stale_result_suspends_and_keeps_reservation`, `test_old_writer_and_stale_step_are_rejected` |
| Reservation expansion across each limited resource | `test_reservation_over_limit_rejected_without_dispatch`, `test_every_limited_resource_is_admitted_before_dispatch` |
| Candidate usage forgery and decreasing trusted totals | `test_candidate_cannot_underreport_usage_with_annotations`, `test_partial_usage_late_receipt_after_finish_never_reopens_result` |
| Missing/partial usage; no double counting | `test_missing_usage_carries_obligation_into_next_admission`, `test_same_component_partial_measurement_replaces_reservation` |
| Overrun recorded, crash-safe dispatch stop, late overrun after finish | `test_overrun_is_recorded_and_stops_further_dispatch`, `test_overrun_at_settlement_crash_is_still_stopped_on_recovery`, `test_late_overrun_keeps_finished_execution_closed` |
| Restore without candidate execution, preserving obligations | `test_operator_restore_uses_durable_command_preserves_accounting` |
| Candidate host/credential/storage/evidence/network/tool/import attacks | `test_runtime_sandbox.py::test_candidate_cannot_access_host_authority_or_escape` |
| Scoped bytes, descriptors, protected-input projection | `test_scoped_input_bytes_only_and_no_inherited_descriptors`, `test_supervisor_denies_protected_input_projection` |
| CPU, wall, output, heap and resident-memory attacks | `test_candidate_resource_limits`, `test_rss_watchdog_includes_arraybuffers_outside_v8_heap` |
| Broken candidate and forged authority output | `test_broken_candidate_suspends_and_operator_can_restore`, `test_candidate_cannot_return_an_authority_record` |
| Candidate invocation recovery and cumulative time | `test_candidate_step_crash_boundaries`, `test_candidate_time_is_reserved_and_survives_restart` |
| Model result delivered through charged sandbox invocation | `test_model_result_is_retained_in_next_sandbox_command` |
| Profile pinning and changed settings | `test_sandbox_reports_pinned_enforcement`, `test_resume_rejects_changed_sandbox_limits` |
| Unimplemented OS floor | `test_production_os_confinement_floor`, strict-xfail |
| Pure fresh-interpreter replay | Existing `test_verifier_only.py::test_fresh_interpreter_verifier_is_read_only_and_candidate_free` and runtime guarantee 5 |

No broad acceptance probe was falsely closed. Guarantee 1 still requires a
confined real harness process tree, and guarantee 3 still requires real launch,
gateway response spooling and upstream recovery. Their strict-xfail reasons now
name M4 and the passing M3 coverage. Guarantees 2 and 4 retain their original
strict-xfail status. Guarantee 5 remains passing.

The implementation resolves three protocol details without editing the frozen
contracts. Invalid candidate commands are validated before durable acceptance,
since M2 cannot discard a pending command; authority and budget are checked
again immediately before authorization. Adapter receipts are cumulative per
resource, with omitted components retaining their previous obligation.
Supervisor-owned sandbox commands retain the prior result while charging the
step as its own effect, rather than adding a second authority schema or an
unaccounted candidate call.

M4 should first provide durable gateway request/response spooling, scoped
capability issuance/revocation, real process-tree launch/termination, and a
qualified confinement profile. Then implement `strive.harness/1` preparation,
wire-request validation, decoding and reconciliation for the selected backends.
Launch-only recovery needs proof that no upstream authorization exists before
revocation, termination and a new epoch. Provider-response/output-incomplete
recovery needs retained raw responses and a deterministic pinned decoder.
The current callback boundary supplies stage authorization and serial accounting;
it does not certify those real-process behaviors, provider billing bounds,
model identities or live backend qualification.

A late overrun can arrive while a new command is already pending. M2 cannot
replace that continuation with a suspension without discarding the command.
The runtime therefore retains it and honors `dispatch_stopped` on both drive
and recovery, even if `execution_status` still says `CONTINUE`. The regression
is `test_late_overrun_preserves_accepted_command_without_dispatch`.

Validation:

- Strict mypy passes on 85 files, including `check_wheel.py`.
- Final vNext suite: 239 passed, 5 strict expected failures. This includes
  72 passing new runtime cases and the production-floor xfail.
- Full suite: 532 passed, 5 xfailed, 2 failed in 194.25 seconds. It collected
  before the final six cases, all covered by the final vNext run.
- The only full-suite failures are unchanged
  `tests/test_packaging.py::test_wheel_ships_package_data` and
  `test_installed_console_script_runs_in_isolated_env`. Their `uv build` child
  exits 101 in macOS `system-configuration-0.6.1`, before building project code.
  The [M2 report](../milestone-2-storage-verification/README.md) records the same
  failure. Neither test was weakened, skipped or converted to xfail. The full
  suite green gate remains blocked by this environment.
- A separate cached-Hatchling wheel build verifies the new runtime modules and
  JavaScript bootstrap, imports the extracted wheel and runs its legacy CLI.
  The additional new file `milestone3-effects/check_wheel.py` makes that check
  reproducible. It does not claim an isolated dependency-install pass.
- `git diff --check` passes. No commits, history edits or PRs.

Commands used the existing environment with `UV_NO_SYNC=1 UV_OFFLINE=1` and
`uv run mypy --strict` / `uv run pytest`; cache, `TMPDIR` and pytest basetemp
were under `milestone3-effects/.work`. The wheel check uses the existing project
interpreter with `-B` and a read-only cached build backend. Generated test data,
caches and wheel files were removed before handoff.
