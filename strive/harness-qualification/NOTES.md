# Harness qualification notes

- Read Amendment 1 and M1 harness/binding/recovery contracts, M2 codec/verifier/CAS, and M3 supervisor/broker/ledger/Deno sandbox. Core modules will stay unchanged.
- Installed opencode, codex, Claude Code and Deno were found. CLI help exposes relevant controls, but help is not qualification.
- Seatbelt probe failed with `sandbox_apply: Operation not permitted`. Native process network/filesystem isolation cannot be claimed here. No native generation will run without that boundary.
- Git status emitted a harmless fsmonitor IPC error; use read-only `git -c core.fsmonitor=false` checks.
- Frozen verifier forbids changing an existing launch authorization epoch when adding upstream authorization. Safe recovery must preserve that restriction; no opaque session resume or hidden redispatch.

- Added gateway spool, narrow text provider contracts/HTTP transport, adapters, registry/profile pins, Deno process fixture confinement, and M3 EffectAdapter bridge. Strict mypy passes for these files.
- Gateway consumes the capability and retains wire bytes before dispatch. Provider response bytes are fsynced before HTTP completion reaches the child.
- uv dependency resolution repeats the macOS system-configuration NULL-object panic already recorded in M3. `uv run --no-sync --offline` uses the existing environment successfully. All caches, temporary work and pytest artifacts are directed inside strive.
- The papercut CLI reports the parent repo has not opted in. No external log was created.
- Recovery resolution: M2 disallows new-epoch authorization on an old effect. A proven no-dispatch launch closes with a failed result/zero provider usage; restart is a new accepted effect after consuming that result. Ambiguous forwards never use this route.

- Host also denies `bind(127.0.0.1, 0)` with EPERM. Added inherited-pipe transport for the same durable gateway; Deno fixture process has all network denied. Optional HTTP loopback test skips with the actual bind error. Native drive remains unqualified.
- Fixed crash injection classification: a simulated process-owner death must not be recorded as a hostile auxiliary call. Focused crash suite passed 13 cases.
- Added bounded local wall time to the existing ledger reservation and a separate watchdog that revokes before killing the process group. Unknown recovered process time keeps its wall obligation.
- Known response with a nondeterministic native decoder returns an explicitly incomplete failed generation, settles provider usage, retains unknown local wall usage, and never fabricates a proposal.
- Local version probes confirm opencode 1.17.18, codex-cli 0.153.4, Claude Code 2.1.263. No native generation was launched.

- Guarantee 3 and the split confinement probe passed through RuntimeAcceptanceDriver in a focused run: 67 passed, 1 socket-bind skip, 3 strict xfails. The later accounting/suspension pass reported 22 passing cases.
- Added a public-API HarnessExecution composition layer because frozen M3 Receipt cannot both carry known usage and request suspension. It books actual usage first, then commits Suspend; a durable gateway stop also blocks future admission.
- Recovery now checks retained process birth identity before best-effort process-group termination. Darwin's check/kill pair is not atomic; native process-tree isolation across parent death remains deferred. The SDK proc_bsdinfo layout was read locally.
- Separated retained wire bytes from actual upstream-send intent. A wire-only record with no supervisor upstream authorization can prove no dispatch. Upstream authorization without outcome remains ambiguous. Revocation also fences an admitted request that has not yet begun sending.
- The complete repository run started before these final recovery hardenings. A final vNext run will cover the finished source after it completes.

- Full repository run: 603 passed, 7 skipped, 4 xfailed, 2 failed in 753.27 seconds. Only the two unchanged legacy packaging tests failed, both in uv's macOS system-configuration initialization before project code built.
- Cached Hatchling wheel build and installed imports/legacy CLI smoke pass, including the added process identity module.
- Final checks added a canonical Deno permission-profile gate and implemented the frozen effect-scoped gateway `forward` method on the same one-use capability. Focused permission checks and interface checks each passed 3 cases, including fresh pure replay of a real harness history.
- Model/process metadata is retained in typed CAS receipt evidence because frozen M3 Receipt has no metadata slots; no top-level observation-schema or supervisor edit was made.

- Final vNext run passed: 309 passed, 7 skipped, 4 strict xfails in 589.21 seconds. The two last service-interface/profile controls pass in focused runs. The full gateway test file is being rechecked against the finished source.

- Finished-source gateway suite: 23 passed, 1 localhost-bind skip in 81.09 seconds. Strict mypy passes for all 103 configured source files and for the standalone wheel-check script.
- Saved the tracked acceptance-test change as existing-files.diff. Core baseline checks and git diff --check pass. No commit or PR was made.
- Removed generated CAS/executable copies, wheel/extracted package, temporary test directories and uv cache before handoff.
