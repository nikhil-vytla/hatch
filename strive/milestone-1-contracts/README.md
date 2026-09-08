Milestone 1 adds `strive.vnext.contracts` alongside the existing implementation.
The authority is [ASTRA_DESIGN.md](../docs/ASTRA_DESIGN.md), with Amendment 1
taking precedence. No existing source module, test, configuration, or git history
was changed. No commit or PR was created.

Created files:

- `src/strive/vnext/__init__.py` and `README.md` define the package boundary and frozen decisions.
- `src/strive/vnext/contracts/__init__.py` documents the public modules.
- `primitives.py` defines content and execution identities, scopes, exact money, resources, and model identities.
- `annotations.py` defines bounded opaque diagnostic JSON.
- `bindings.py` defines shared model/harness bindings and resolved provider settings.
- `commands.py` defines the seven-command union, input/output values, and `Step` protocol.
- `feedback.py` defines the A/B/C adaptation and selection matrix.
- `harness.py` defines `strive.harness/1`, its values, and restricted supervisor service protocols.
- `lifecycle.py` defines legal effect transitions and generic/harness recovery actions.
- `manifest.py` defines authored/resolved tables, retained closure, and strict TOML text loaders.
- `records.py` defines the envelope, six authoritative payload groups, owners, and record-class enum.
- `study.py` freezes tau2 scenarios and reference campaign data.
- `tests/vnext/__init__.py`, `fixtures.py`, `test_acceptance_contracts.py`, and `test_manifest_validation.py` contain the acceptance cases and in-memory fixtures.
- `milestone-1-contracts/NOTES.md`, `README.md`, `_summary.md`, and `.gitignore` contain the investigation record and exclude temporary validation artifacts.

Contract-level guarantee map, in [test_acceptance_contracts.py](../tests/vnext/test_acceptance_contracts.py):

| §2 guarantee | Falsifiable test |
|---|---|
| Confinement and fixed authority | `test_integrity_1_candidate_commands_cannot_assign_outer_authority` |
| Independent facts | `test_integrity_2_annotation_claims_cannot_become_authoritative_facts` |
| Durable execution identity | `test_integrity_3_upstream_authorization_requires_exact_request_and_execution_identity` |
| Honest recovery | `test_integrity_4_ambiguous_execution_cannot_be_consumed_or_erased` |
| Small checked protocol | `test_integrity_5_closed_protocol_refuses_skipped_and_repeated_consumption` |

Each also has a `test_runtime_integrity_N_*` case with assertions for the full
runtime guarantee. These are strict expected failures, restricted to
`NotImplementedError`. Their reasons name the future milestones that must wire
the fault-injection driver and remove the markers. They do not hide assertion
failures. Schema tests establish representational constraints only.

Milestone 1 deliverables map to these named tests:

| Frozen item | Test |
|---|---|
| Authority schema and owners | `test_exit_authority_schema_freezes_all_groups_and_owners` |
| Step interface | `test_exit_step_interface_has_one_exhaustive_seven_command_union` |
| Effect lifecycle/recovery | `test_exit_effect_lifecycle_and_recovery_cover_every_dispatch_stage` |
| Amendment 1 harness boundary | `test_exit_harness_adapter_freezes_four_methods_and_three_model_identities` |
| Authored/resolved manifests | `test_exit_manifest_separates_authored_paths_from_resolved_content` |
| Simulator scenarios | `test_exit_simulator_scenarios_cover_tau_agent_user_state_and_trusted_reward` |
| Feedback matrix | `test_exit_feedback_matrix_freezes_a_b_and_defers_c` |
| Reference study | `test_exit_reference_study_freezes_split_exposures_selection_and_allocation_formula` |

Additional cases reject unknown core keys in every table, missing required
fields, unsafe harness profiles, invented zero usage, unsupported recovery,
conflicting price schedules, and an omitted enabled cost phase. Static
`assert_never` checks make the command handler exhaustive under strict mypy.

Decisions where the specification leaves representation open:

- The envelope wraps a payload; it is not an eighth record class. Amendment 1
  fields extend the existing six authority classes. Annotations are the seventh
  class and have no authority owner.
- Unknown annotation payload keys remain opaque even when named `reservation`
  or `metric_value`. Authority fields cannot be supplied on `Annotation` itself.
  The concrete per-record cap is 65,536 UTF-8 JSON bytes. Total storage quotas
  require the future storage/runtime implementation.
- Money uses integer nanodollars. Finer nonzero precision is rejected. No float
  conversion or decimal-context rounding occurs.
- `SETTLED` means known components were booked; usage completeness remains
  independent. Unknown components retain obligations through consumption.
  `AUTHORIZED_RESERVED` may reach `RETURNED` after a recorded local failure or
  reconciliation without a separate dispatch observation. This is not permission
  to redispatch. Late receipts never reopen finished execution.
- The amended continual parameter is `refine_every_episodes`; the old order
  parameter is rejected. Inline policy parameters require a pinned validator;
  the default accepts the two reference-policy parameters. Core schemas remain
  closed. `task_stream` and corpus names remain as specified, now referring to
  episode/task artifacts.
- `harnesses` is optional for entirely direct-provider configurations. Harness
  names stay open registry keys. A version string cannot substitute for the
  resolved executable, adapter, launch-profile, or sandbox-profile references.
- A can omit its validation-corpus reference; B requires one. C has no release-1
  grants and is rejected. Operational failures remain conditional on authorized
  manifest access. The audit-plan reference never grants candidate access.
- Authored phase checks cover declared model roles, B validation, and enabled
  reference-policy forks. The resolved closure supplies the full enabled-phase
  set, including custom policy, campaign, and reconciliation costs.
- The inserted harness milestone makes later numbering ambiguous. Expected
  failures use the design's milestone titles, with original numbers only where
  they remain useful.

The reference plan freezes the 60/14/40 split sizes, eight trajectory pairs,
180-episode development horizon, eight refinement opportunities, two audit
repetitions, 4,160 main episodes, and allocation formula `4,184E + 68F`. It does
not invent an upstream commit, task IDs, grouping hashes, account-specific prices,
funded ceiling, or protected audit allocation. Workload qualification and funded
campaign resolution must supply those retained values before execution.

Milestone 2 must first implement an isolated artifact root, durable CAS
publication, framed ordered commits, and one-writer ownership. Then implement
producer-specific append interfaces, pure preflight, and full replay against
these contracts. Its first runtime gate rejects corrupted references and
malformed authority in a fresh interpreter without candidate imports, while
accepting unknown bounded annotations. Human review of this freeze precedes
teardown of the existing implementation.

Validation:

- `uv run --no-sync mypy --strict`: success across all 62 source/test files.
- `uv run --no-sync pytest tests/vnext -q`: 116 passed, 5 strict expected failures.
- Full `uv run pytest -q`, with `UV_NO_SYNC=1` and offline caches: 349 passed,
  5 expected failures, 2 failed in 194 seconds. This run collected the original
  50 new checks; the 66 additional manifest checks passed in the targeted run.
- Both failures are existing packaging tests:
  `tests/test_packaging.py::test_wheel_ships_package_data` and
  `tests/test_packaging.py::test_installed_console_script_runs_in_isolated_env`.
  Their `uv build --wheel` subprocess exits 101 before building, with
  `system-configuration-0.6.1/src/dynamic_store.rs:154:1` and
  `Attempted to create a NULL object`. A standalone build reproduces it.
  Consequently the complete suite cannot be reported green in this environment;
  wheel/installed-CLI qualification still needs a working uv process.
- Ordinary `uv run` also reaches that panic during dependency synchronization.
  `UV_NO_SYNC=1` uses the existing environment. It does not bypass test assertions.
- No network was used. uv ran offline and Deno used `--cached-only`; all temporary
  caches and test files stayed inside `strive/` and were removed afterward.
- Read-only git inspection shows only the new work folder, `src/strive/vnext/`,
  and `tests/vnext/`. Existing tracked files have no diff.
