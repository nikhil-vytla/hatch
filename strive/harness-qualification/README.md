# Harness qualification

This milestone adds a durable model gateway, three `strive.harness/1` adapters, pinned launch profiles, and a bridge to M3's existing effect interface. All generation tests use a local gateway and deterministic provider fixtures. Native opencode, Codex and Claude Code execution remains gated on a tested outer OS jail; none is claimed qualified for funded execution on this host.

The supervisor, broker, ledger, verifier, frozen contracts, command schema, workload and policy implementations are unchanged. `core-baseline.json` records the M1 through M3 module hashes, checked by `test_core_unchanged_and_adapters_selected_by_manifest`. No legacy modules were removed. No commit, history edit or PR was made.

## Implementation

New files under `src/strive/vnext/harness/`:

- `provider.py`: pinned text protocol, whole-generation bounds, strict request validation, fixed-route credential-owning HTTP transport. No redirects, ambient proxies, retry or fallback.
- `gateway.py`: effect/epoch capability, atomic one-use admission, CAS request/response retention, durable SQLite spool, verified recovery lookup and durable run stop.
- `http_gateway.py`: a bounded localhost HTTP endpoint for that gateway.
- `process.py`: fresh Deno fixture process, inherited gateway pipe, bounded stdout/stderr, deadline watchdog, process-group termination and M3 rlimit/RSS helpers.
- `process_identity.py`: retained process birth identity and revocation before recovery termination. The Darwin birth-check/kill pair is best effort, not an atomic native process-tree jail.
- `profiles.py`: native profile proposals and the exact Deno fixture argument list. Native launch fails closed before issuing a capability.
- `decoding.py`: opencode JSONL, Codex `item.completed`, and Claude Code `result` decoders; typed proposals remain data.
- `adapters/base.py`, `adapters/opencode.py`, `adapters/codex.py`, `adapters/claude_code.py`, `adapters/__init__.py`: describe/prepare/invoke/reconcile and open registry resolution through manifest harness bindings.
- `bridge.py`: translates to the existing M3 `EffectAdapter`, `PreparedEffect` and `Receipt` interfaces.
- `execution.py`: composition through the supervisor's public methods. It settles known provider usage before committing an ordinary `Suspend` for a model mismatch or forbidden extra request. It does not alter the core supervisor.
- Package `__init__.py`.

Tests and fixtures are in `tests/vnext/test_harness.py`, `test_harness_gateway.py`, `harness_support.py`, `harness_acceptance.py`, and `harness_fixtures/client.js`. The existing `test_acceptance_contracts.py` selects the new driver, closes guarantee 3 and adds the enforced part of guarantee 1. Its other deferred probes remain strict xfails.

The gateway retains the submitted context separately from the actual wire JSON, which can include harness-added context. The complete provider response reaches CAS and the durable spool before the child receives it. Final receipts reference the prepared generation, exact outer launch record, wire request, provider response, decoder output and typed requested/wire/observed model identities. The provider's model field establishes observed identity; a CLI echo does not. Model aliases retain an unknown immutable revision.

Only text requests covered by the pinned contract are admitted. Nonempty tool catalogs, hosted tools, unknown billing options, streaming, session linkage, unsupported content types, duplicate JSON keys, excessive output limits and oversized requests fail closed. A rejected request burns its capability. A second request cannot reach the provider even through another gateway connection.

The bound reserves the provider contract's entire billable input ceiling and inclusive output ceiling, including reasoning, plus fixed uncached prices, request fees, one model call and local wall time. This is deliberately restrictive: no real provider/model/price contract is invented by the fixture profile. A funded deployment must supply retained provider evidence for the ceilings and prices. Missing or partial usage keeps the unknown ledger components; complete components replace their obligations. Recovered unknown process time remains a wall-time obligation. CLI token and dollar totals are diagnostics. The existing ledger records overruns and stops dispatch.

## Parity and fault coverage

`test_opencode_codex_parity` sends identical fixture response bytes through both output formats. It compares typed proposals, token/cost settlement, remaining obligations, continuation state, consumption count and provider dispatch count. Cases include complete return, provider completion before local spool, captured response before native return, and captured native return. Wall-clock measurements are independently measured, not asserted equal.

| Attack or interruption | Test |
|---|---|
| Second call, retry, title, compaction, subagent, auxiliary endpoint | `test_gateway_denies_hidden_calls_tools_options` |
| Executable/hosted tools, wrong wire model, billing/session options, oversized request | `test_gateway_denies_hidden_calls_tools_options` |
| Credential, file, write, network, Unix socket, process and FFI escape | `test_fixture_process_denies_files_network_tools_credentials` |
| Malformed/forged output or child exit after provider response | `test_bad_harness_output_still_settles_known_usage` |
| Missing/partial usage, diagnostic zero totals, exhausted remaining budget, overrun | `test_usage_uses_provider_receipt_not_harness_totals` |
| Unknown or mismatched observed identity despite model echo | `test_model_echo_is_not_observed_identity` |
| Launch retention, process start, wire retention, forwarding, upstream return, spool, native return | `test_process_gateway_crash_boundaries` |
| Supervisor return, settlement and continuation interruption | `test_supervisor_consumes_gateway_result_once` |
| Unverified upstream recovery | `test_unverified_provider_recovery_never_queries_or_retries` |
| Nondeterministic decoder | `test_nondeterministic_decoder_preserves_incomplete` |
| Wrong token, stale epoch, expired/revoked capability | `test_capability_stale_epoch_expiry_and_revocation` |
| Competing gateway connections | `test_atomic_single_dispatch_across_gateway_connections` |
| Repeatable no-dispatch proof and replacement attempt | `test_no_dispatch_proof_revokes_and_is_repeatable`, `test_denied_request_burns_capability_before_replacement` |
| Duplicate keys, nonfinite JSON, bool limit, image content | `test_strict_wire_protocol` |
| Unbounded accounting, settings/scope mismatch, multi-request binding | `test_prepare_rejects_unbounded_profile_settings_and_scope` |
| Context versus wire evidence | `test_request_and_response_evidence_distinguishes_context` |
| Stale receipt, duplicate settlement and consumed result | `test_stale_receipt_and_duplicate_settlement_cannot_consume_again` |
| Recovery before launch; replacement epoch and effect | `test_no_launch_restart_requires_new_epoch_and_effect` |
| Recovery termination and reused PID | `test_recovery_revokes_then_terminates_identified_old_process`, `test_recovery_never_signals_a_reused_process_id` |
| Deadline, output flood, early child exit | `test_process_deadline_output_limit_and_early_exit` |
| Model mismatch plus accounting overrun | `test_model_mismatch_still_records_real_usage_and_overrun` |
| Native launch without outer jail | `test_native_admission_fails_before_process_or_capability` |
| Pure fresh-interpreter replay of actual harness history | `test_harness_history_replays_in_fresh_pure_interpreter` |
| Weakened sandbox profile or frozen gateway interface | `test_profile_cannot_weaken_mechanical_deno_permissions`, `test_frozen_effect_scoped_gateway_interface_uses_same_single_dispatch` |
| Cancellation between admission and send | `test_revocation_between_admission_and_send_prevents_upstream` |
| Changed gateway or installed adapter implementation | `test_gateway_contract_change_cannot_resume_old_capability`, `test_registered_implementation_source_is_part_of_adapter_pin` |
| Credential placement, fixed route, no redirect/retry | `test_http_provider_owns_credentials_fixed_route_and_never_retries` |

## Confinement and host limits

| Mechanically enforced for the process fixture | Deferred for arbitrary native CLI processes |
|---|---|
| Deno denies all filesystem reads/writes, environment access, networking, subprocesses, FFI, system access and imports after loading the pinned entry module. Only the inherited gateway pipe carries model traffic. | An outer OS jail must enforce a minimal filesystem, host home/keychain/credential/audit-storage denial and gateway-only network for the entire native process tree. |
| Fresh process session and scratch directory, explicit environment, closed inherited descriptors, process-group kill, revocation before cancellation. | Native descendant containment across parent death, daemonization and native runtime behavior needs tested OS support. |
| M3 CPU, per-file-size, descriptor and core-dump rlimits; output cap; V8 heap cap; RSS polling; independent deadline watchdog. | Hard whole-process memory limits and aggregate storage quota need a container/VM or equivalent tested OS controls. RSS polling is not a hard allocation bound. |

Seatbelt is installed but `sandbox-exec` fails with `sandbox_apply: Operation not permitted`. Localhost TCP `bind` also fails with EPERM in this runner. The HTTP gateway test therefore skips with the observed bind error; real process qualification uses the pipe transport of the same gateway. This proves neither native TCP isolation nor an end-to-end HTTP provider integration.

CLI permission flags and profile settings are additional controls, not an OS jail. Linux native qualification would need tested mount/user/network namespaces, cgroup v2 memory limits and storage quotas or a VM. Darwin needs usable Seatbelt plus separate hard memory/storage controls and a solution for process-tree containment across owner death. Native profiles are proposals for qualification, including effective configuration data, and are rejected at launch until the external-process boundary is implemented. The native CLI tests do not silently substitute the process fixture and call it a CLI drive.

`cli-versions.json` records local version-only probes:

| CLI | Installed | Deterministic native generation |
|---|---|---|
| opencode | 1.17.18 | Skipped: no qualified outer jail; single-request native behavior untested. |
| codex | 0.153.4 | Skipped: no qualified outer jail; single-request native behavior untested. |
| Claude Code | 2.1.263 | Skipped: no qualified outer jail; single-request native behavior untested. |

A separate explicitly skipped funded-live-smoke placeholder exists for each backend. Enabling funded execution requires a human budget ceiling and a qualified native process boundary. No committed test invokes an external provider API.

## Recovery and contract decisions

M1's recovery table remains authoritative. Native resume/continue/session IDs are never used for recovery, and a transcript identifier is not an idempotency key. Upstream lookup is permitted only when the pinned provider contract supplies a verified operation-key mapping; the fixture contract implements it durably. Production HTTP transport has no assumed recovery behavior.

M2 forbids adding a new-epoch upstream authorization to an existing old-epoch launch effect. After proving no dispatch, the gateway durably revokes the old capability and the local attempt closes with a failed result and zero model usage. The caller consumes that result and accepts a new effect under the new epoch. This preserves the frozen verifier and does not silently reuse the old effect or reservation. A missing outcome after forward authorization suspends with the obligation held.

Captured provider responses settle known provider usage. A deterministic pinned decoder can recover the proposal without a new process or model call. Otherwise the result explicitly preserves an incomplete generation and unknown local wall usage; it does not invent decoded text. Complete returns and consumed continuations recover from bytes only.

The frozen M3 receipt has no fields for process or model-identity metadata. Those values are typed CAS evidence reachable from the ordinary receipt references; the existing optional observation columns remain unset. Report readers must inspect the retained gateway receipt evidence.

The frozen M3 receipt cannot request an execution-status transition. `HarnessExecution` therefore uses the existing public supervisor methods to settle and suspend in order. The gateway also persists a run stop that blocks subsequent model admission, including after restart. This avoids reporting an invented accounting overrun merely to force a suspension.

Guarantee 3 is exercised by `HarnessRuntimeDriver` across both dispatch stages, spool recovery, settlement and continuation. Completed results consume once; ambiguous forwards consume zero times and suspend. The enforced candidate/fixture-process portion of guarantee 1 passes. Its native OS confinement floor remains strict-xfail, as do guarantees 2 and 4. The M2 fresh-interpreter purity probe is retained, with an additional probe for the new harness history.

## Milestone 5

Start with the trusted tau2 operation journal and lookup contract, before an actor loop. Pin the September 2026 telecom text revision, tasks, policies, environment, dependency closure, split and deterministic reward criteria. Implement atomic effect-ID/argument-digest/state/receipt commits for episode initialization, both parties' tools, message delivery, termination and snapshots. Snapshots must contain both sides' state, conversation position and randomness. Then connect the independently brokered user model, trusted scorer and protected evidence grants. Reject any imported headline task whose required grading cannot be reproduced deterministically.

References: [Amendment 1](../docs/ASTRA_DESIGN.md), [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference), [tau2-bench](https://github.com/sierra-research/tau2-bench).

## Verification

- Strict mypy: clean across 103 source files.
- Full repository run: 603 passed, 7 skipped, 4 xfailed, 2 failed. Both failures are unchanged legacy packaging tests whose `uv build` exits 101 in macOS `system-configuration-0.6.1` before building project code. This is the same environment failure recorded in M2 and M3; neither test was weakened.
- The full run collected before the last recovery hardening. The final vNext run passed: 309 passed, 7 skipped, 4 strict xfails. Two service controls added after its collection also pass in focused tests, including another fresh-interpreter replay of a real harness history. The complete gateway test file was then rechecked against the finished source: 23 passed and 1 localhost-bind skip.
- A separate cached-Hatchling build, wheel-content check, installed-adapter import and legacy CLI smoke pass. `check_wheel.py` reproduces that check; it does not establish an isolated dependency-install pass.
- `pytest-output.txt`, `mypy-output.txt`, `vnext-output.txt`, `permission-tests.txt`, `interface-tests.txt`, `gateway-output.txt` and `wheel-output.txt` retain the check output. Generated CAS/runtime copies and temporary artifacts are removed before handoff.

 Commands use the existing environment with `UV_NO_SYNC=1` and `UV_OFFLINE=1`; cache, TMPDIR and pytest basetemp remain inside this project. Plain uv dependency resolution hits the macOS `system-configuration` NULL-object panic already documented in M2 and M3.
