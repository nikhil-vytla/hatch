# Milestone 8 jail wall accounting

The Linux jail now starts the candidate wall deadline when the trusted Deno bootstrap signals readiness. A separate 30-second deadline bounds startup. A ten-second candidate under a 0.2-second execution budget still raises `SandboxFailure("candidate wall limit exceeded")` in the host-executable jail-supervision regressions. Native Linux confirmation requires the orchestrator rerun; no container was run on this macOS host.

## Root cause

The retained Linux traceback in `.container-results/pytest.txt` shows that `_capture()` raised the expected wall-limit failure during jail startup. Its `finally` block then called `LinuxJail.close()`, whose five-second `process.wait()` raised `subprocess.TimeoutExpired` and replaced the original error. Cleanup only killed the cgroup, which could still be empty because `_enter_cgroup.py` had not attached the launch process yet.

## Mechanism

- The jail path prepends a synchronous ready marker to the temporary trusted bootstrap. Deno emits it before reading input or evaluating any candidate source. The frozen bootstrap file and tagged candidate wire format stay unchanged.
- The supervisor allows 30 seconds for startup, consumes the first complete marker, and starts the existing `wall_seconds` deadline. It handles split reads and a marker coalesced with candidate output. Later markers count as candidate output and cannot reset the timer.
- Startup hangs raise `SandboxFailure("candidate jail startup limit exceeded")`. Execution timeouts, including a candidate that closes stdout and stderr, raise the normal wall-limit `SandboxFailure`.
- Cleanup kills the launch process group, then uses `cgroup.kill` for the entire confined tree, including descendants in separate sessions. It reaps the launcher before removing the cgroup. An exceptional post-kill wait timeout becomes a distinct `JailUnavailable` cleanup error rather than a raw `TimeoutExpired`.

## Confinement and scope

The ready marker uses existing stdout. It adds no descriptors, permissions, mounts, environment values, network access, or candidate-controlled deadline extension. Namespace isolation, seccomp, cgroup memory/pid limits, tmpfs quotas, Deno permissions, CPU limits, and output limits retain their enforcement. Unsupported hosts still delegate directly to the original permission sandbox.

All 30 frozen hashes match. Core, contracts, verifier, ledger, gateway, `_limits.py`, the original permission sandbox, tau2 split/certification code, and codec work were not changed.

Files changed:

- `src/strive/vnext/runtime/confined_sandbox.py`
- `src/strive/vnext/runtime/linux_jail.py`
- New `tests/vnext/test_confined_sandbox_wall.py`
- Investigation artifacts in this folder

The [patch](changes.patch) contains only this task's changes against the initial working files, including the new test. Existing Milestone 8 changes were preserved. No commit was created.

## Validation

- Targeted sandbox suite: **49 passed, 11 skipped**. The skips require Linux confinement.
- Strict mypy: **180 source files, no issues**, using `uv run --no-sync mypy --strict` against the existing environment. The exact sync-enabled invocation hit the previously recorded macOS uv system-configuration panic before mypy started. Both outputs are retained.
- Full host suite: **785 passed, 24 skipped, 1 expected failure, 2 failed** in 1132.81 seconds. Both failures are legacy packaging tests stopped by the same macOS uv panic during `uv build`, before wheel creation. No vNext tests failed. The full run began before the final reaped-PID guard and its added regression; the final targeted rerun covers that delta.
- Scope verification: **30/30 freeze hashes match**, only the two intended existing runtime files changed since the baseline.

New regressions cover startup longer than the execution budget, the exact ten-second sleeper, top-level source execution, closed output pipes, startup hangs before cgroup attachment, missing/invalid/fragmented ready markers, output accounting, repeated marker output, and cleanup error normalization. Two additional native Linux cases inject a 0.4-second delay before Deno, check quick-candidate success versus graceful timeout, and require cgroup and scratch cleanup. The original `test_candidate_resource_limits` remains unchanged by this task.

For the Linux rerun:

```sh
STRIVE_REQUIRE_JAIL=1 uv run --no-sync pytest tests/vnext/test_confined_sandbox_wall.py tests/vnext/test_runtime_sandbox.py tests/vnext/test_linux_jail.py -q -ra
```

See [NOTES.md](NOTES.md), [scope verification](scope-verification.json), [targeted test output](pytest-targeted.txt), [full host output](pytest-host.txt), [result counts](host-results.json), and [strict mypy output](mypy-no-sync.txt).
