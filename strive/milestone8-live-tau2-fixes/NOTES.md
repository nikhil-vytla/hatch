# Live tau2 repair notes

- Scope: three live tau2 failures only; no tau2 install/run, container run, core/jail edits, or commit.
- Captured the existing worktree hashes before edits. All 30 frozen core hashes match. Existing uncommitted container/jail/adapter work is preserved.
- Read captured failure summary and located complete tracebacks. Equivalence actually stops at captured user protocol equality, before comparing rewards. Integration stops at CAS.publish because objects/ is absent.
- Initial inspection hit a git fsmonitor IPC error and no on-disk AGENTS.md; the supplied AGENTS instructions apply. Subsequent git reads disable fsmonitor.

- Pinned upstream inspected via raw GitHub at a2c024725189473d2d7cea3a5cfdbcc67478e41f. EnvironmentEvaluator.calculate_reward builds the DB target with make_tool_call but runs assertions on predicted_environment after strict trajectory replay. Environment.make_tool_call does not sync; get_response does. Reference qualification now records actual calls with get_response, then invokes the evaluator on that trajectory; the separate strict raw gold-action check remains.
- UserState.flip_roles reconstructs messages with default wall-clock timestamps. generation_request excludes only each message top-level timestamp, preserving tool arguments including any timestamp argument; plan equality is still exact on everything else. Upstream to_litellm_messages also omits these metadata timestamps.
- Scoring delegates deterministic components to their pinned calculate_reward methods and combines component rewards with evaluate_simulation ALL semantics. This preserves None/empty env handling, non-short-circuit assertions, communication normalization, and action membership. Premature stops return zero after integrity validation.
- Full captured qualification JSON also reports 2,285 IDs in connected scenario groups crossing train/audit, independent of assertion failures. Extracted the exact report into captured-qualification-failures.json. No split/group normalization change is authorized or made.
- First uv run mypy --strict passed, 175 source files. Full host suite started.
- Papercut logging is not enabled in the parent git repo. Shell curl cannot resolve GitHub; used the web tool for pinned source inspection. The 13.3 MB tasks.json could not be retrieved by web, so no new full-inventory execution or data inspection is claimed.

- Added 10 host regressions for timestamp normalization, binding of model/content/role/tools/settings/tool arguments and IDs, synchronized reference action ordering, preservation of initial history, and rejection of reference tool errors. Focused run: 27 passed, 4 skipped in 0.37s, including qualification gates and host tau2 skips.
- Live equivalence now compares against evaluate_simulation(EvaluationType.ALL), including premature termination, comma/case normalization, mixed reward bases, absent action/assertion lists, and diagnostic-only assertions. Existing live test entry points and assertions are preserved.
- Final implementation typecheck: no issues in 176 source files. A later uv call could not read its usual cache; UV_CACHE_DIR=/tmp/strive-tau2-uv-cache avoids that sandbox issue.
- Scope audit: only native_worker.py and live_checks.py differ among existing files. Added test_tau2_worker_regressions.py. All 30 core-freeze hashes still match, including the untouched verifier, ledger, contracts and benchmark store.
- Captured crossing groups contain 1,984 mms_issue, 254 mobile_data_issue, and 47 service_issue inventory IDs. The existing qualification grouping depends only on original task data, so changing execution checks cannot remove this blocker.

- Saved changes.patch with git diff --no-index against the starting file bytes, excluding pre-existing changes. It includes both adapter edits and the new regression test.
- A normal uv run mypy --strict with a fresh cache hit the known macOS system-configuration NULL-object panic before invoking mypy. The --no-sync invocation passed after all code edits; this is a host uv issue, not a type failure.
- Wrote README.md and _summary.md, including pinned evaluator references, the exact scope, and the unresolved split-overlap finding.

- Full host suite completed successfully: 745 passed, 20 skipped, 1 xfailed in 1090.68s. It collected before the ten new tests were written; all ten passed separately in the focused 27-passed/4-skipped run. Live tau2 remained absent and skipped on the host.
- Final patch reverse-application check and whitespace check passed. Final frozen hashes and source-scope audit passed. No commit created.
