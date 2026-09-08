# Milestone 2 notes

- Started storage and pure verification implementation. Scope: new artifact format, CAS, framed journal with lease and epochs, pure verification/replay, and guarantee-5 acceptance coverage.
- User constraints: write only within strive; no git history changes, commits, PRs, network, model calls, or runtime subprocess dispatch.
- Read design sections 3/4/7.6/10.2 and Amendment 1, all frozen record/lifecycle types, and runtime acceptance probes.
- Producer authentication will use protected run-local MAC keys and producer-specific append ports, with an independent supervisor seal. Keys and initial grants are trusted host metadata, never candidate inputs or CAS objects. This is not a portable signature or protection from host compromise.
- Revision IDs derive from RunBinding/RevisionActivation record IDs; no contract fields change.
- Annotation replay must bypass the frozen constructor's JSON-content validation while retaining namespace and byte-size checks. Payload bytes are never parsed by verification.
- Git status hit an unavailable fsmonitor socket. Papercuts logging was unavailable because the enclosing repository is not opted in; no file was created outside strive. Read-only git checks now disable fsmonitor.
- Implemented closed canonical codec, opaque annotation decoding, immutable CAS publication, MAC-authenticated commit transport, framed journal reads, and POSIX flock/epoch ownership.
- Implemented pure immutable preflight/replay over read-only handles, including combined return+settlement through both legal lifecycle edges and cumulative per-component accounting.
- First validation attempt (`uv run mypy`, offline, cache inside strive) crashed in uv's macOS system-configuration initialization. Trying `uv run --no-sync` against the existing environment.
- Initial storage tests exposed a codec bug: NewType optionals use typing.Union on this interpreter, not only types.UnionType. Added support for both; frozen types remain unchanged.
- Kept pytest scratch data under strive. The first basetemp attempt needed its parent directory created; corrected it before rerunning.
- 31 storage/verifier cases passed, followed by all vNext tests: 150 passed, 4 xfailed. Guarantee 5 is now a real passing runtime probe.
- Fresh probe uses an isolated Python interpreter with bytecode writes disabled, import guards, and an audit hook denying filesystem mutation, process dispatch, and sockets. It accepts opaque non-JSON annotations and rejects corrupt result bytes.
- `UV_NO_SYNC=1 UV_OFFLINE=1` avoids the uv initialization crash using installed dependencies. Full strict mypy passes on 74 files. Full legacy pytest is running.
- Review found and fixed three protocol edges: observation invocation IDs must match authorization; late accounting cannot rewind environment; committed ApplyChange/RestoreBundle must match and clear their pending command atomically.
- Added direct tests for explicit dispatch/return/settlement cursors, stale returns after reacquiring a lease, required nested command references, scorer ownership, malformed committed payloads, and fsync ordering/failure. Current vNext result: 165 passed, 4 xfailed.
- Import guard now enumerates permitted strive modules, so a future candidate/runtime dependency under vNext also fails the fresh-interpreter test.
- First full legacy+vNext run: 449 passed, 4 xfailed, 2 failed in 168.01 seconds. Both failures are unchanged tests/test_packaging.py tests: their uv build child crashes in macOS system-configuration before the backend starts. Offline, proxy settings, and disabling build isolation do not avoid it. No tests were weakened or skipped.
- Built the wheel directly with the locally cached Hatchling backend, without network or installing/changing dependencies. Verified that vNext modules and legacy policy assets are packaged, then imported the actual wheel and ran the legacy sandbox CLI smoke successfully.
- A final complete pytest run is in progress with all 15 additional edge-case parametrizations. Strict mypy remains clean on 74 files.
- Final accounting review found that dropping zero-valued measured components could lose their known status during a later partial settlement. Per-effect measurements now preserve explicit zeroes, while aggregate totals still omit zero entries. Added a regression for zero input usage followed by a late cost receipt. Latest vNext: 166 passed, 4 xfailed; strict mypy passes.
- Closed a same-process lease race: close() now shares a reentrant lock with append, so another thread cannot release the OS lease during a commit. The new coordinated-thread test keeps a second writer blocked until the active append finishes.
- Final focused vNext run: 167 passed, 4 xfailed. Strict mypy passes on 74 files. Branch verified as strive-astra. No commits, PRs, contract changes, or legacy source changes.

- Final full run finished: 464 passed, 4 xfailed, 2 packaging failures in 171.67 seconds. It collected before the final known-zero and close/append regression tests; both pass in the latest focused result of 167 passed, 4 xfailed. The only remaining full-suite failures are uv crashing before the legacy wheel builds.
- Removed all task-created test scratch data, uv cache, wheel artifacts, and temporary collection/log files. No fetched code or generated binaries are included in the review diff.
