# Tau2 tool-message reconstruction fix

The completed user-tool batch in `native_worker.py` omitted its outer role. Both live equivalence and crash-recovery checks reach this producer through `live_checks.py`. Timestamp normalization was not removing the role.

The [pinned tau2 model](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/data_model/message.py#L519-L565) defines these required fields:

| Model | Required fields |
| --- | --- |
| `MultiToolMessage` | `role: Literal["tool"]`, `tool_messages: list[ToolMessage]` |
| Each `ToolMessage` | `id: str`, `role: Literal["tool"]` |

Neither required role has a default. Nested optional fields default to `content=None`, `requestor="assistant"`, `error=False`, `turn_idx=None`, and a generated timestamp. The batch itself has no timestamp field.

[native_worker.py](../adapters/tau2/src/strive_benchmark_tau2/native_worker.py) now constructs the pending batch through the upstream `MultiToolMessage` with `role="tool"`. A shared serializer retains model fields while excluding timestamps at the message envelope and nested tool-result envelopes. Generation capture uses the same serializer. It preserves requestors, IDs, result content, errors, turn indices, and timestamp values inside tool payloads. Reconstruction keeps upstream model validation.

The new host regression, [test_recorded_tool_batch_reconstructs_required_fields_without_timestamps](../tests/vnext/test_tau2_worker_regressions.py), uses the recorded generation fixture's call ID and authored tool results. Small Pydantic stand-ins reproduce the field schema inspected in the pinned source; the tests do not import or execute upstream tau2. They exercise the production batch encoder, JSON snapshot round-trip, required roles and IDs, stable generation capture after metadata changes, and rejection of the original role-less shape. Additional cases check missing result fields and retained changes to result data. Existing tests are unchanged.

Validation:

- Focused host checks: 19 passed, including nine new cases; four live tau2 tests skipped.
- Strict mypy: all 176 source files passed with `uv run --no-sync mypy --strict`. Plain `uv run mypy --strict` hit the existing macOS `system-configuration` panic before launching mypy.
- Full host suite: **761 passed, 21 skipped, 1 xfailed, 2 failed** in 1110.75 seconds. Both failures are unchanged packaging tests, `test_wheel_ships_package_data` and `test_installed_console_script_runs_in_isolated_env`. Their `uv build` subprocess panics in macOS `system-configuration` before building the package. All 19 tau2 host regressions passed in this run; all four live tau2 tests skipped. A fully green host suite cannot be claimed in this environment.
- All 30 frozen core hashes match. Only the adapter worker and its regression test changed outside this report folder.
- [changes.patch](changes.patch) contains the Git diff against the initial worktree bytes and passes reverse-application checking.

No tau2 installation, upstream execution, container run, or commit was performed. Linux confirmation remains with the orchestrator. Certification, split/grouping, jail, contracts, verifier, ledger, and gateway were untouched.
