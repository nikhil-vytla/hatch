## Initial inspection

Created this folder before investigation. All 30 frozen hashes match. Existing uncommitted files are preserved; no commit or PR will be made. The prior pass added per-thread namespace detection, an owner guard, CONNECT proxy routing, sanitized SQLite/stderr diagnostics, shared deadlines and scripted tests. It did not add a dedicated egress worker. The current launch path uses child-only bubblewrap confinement; no setns call exists in the gateway path, so the historical failure cause is still a hypothesis.

Plan: pin upstream HTTP work to an eagerly started trusted thread, bound connect/read waits including DNS, verify a simulated per-thread namespace change, then run strict mypy and the complete vnext suite.

## Completed transport boundary

The transport now starts a dedicated daemon worker during trusted Campaign setup. Socket creation, DNS, proxy CONNECT, TLS and HTTP all run on that worker. The dispatching thread only waits and writes its serialized SQLite audit. The worker checks its original PID and per-thread netns; the caller is never switched out of its jail. Existing bubblewrap --unshare-net, --clearenv, capability dropping, seccomp, and inherited-pipe routing remain unchanged for candidate/harness processes.

Connect and connected-call waits are capped at 10 and 60 seconds, and both consume the gateway's shared deadline with a one-second return margin. Bounded waits cover blocking DNS and slow response trickles. Cancellation shuts down connected sockets; a late resolver result is closed before HTTP send. A stalled worker cannot accept another dispatch, and shutdown waits at most one second for it. Python cannot forcibly terminate a stuck resolver thread, so it is a daemon with no access to SQLite writes after abandonment.

Diagnostics preserve exception type/message, phase, errno, HTTP status, route, elapsed time, deadline/caps, caller netns, worker netns and native thread ID. API keys, prompt strings and proxy credentials are redacted; arbitrary bad HTTP status lines are suppressed. Counting attempts now also have a durable no-redispatch marker. Campaign recovery still suspends and retains unknown usage.

## Verification in progress

Strict mypy passes. Updated scripted tests passed 33 cases with the real-Linux namespace case skipped on macOS. The campaign test simulates namespace inheritance, confines the dispatch thread immediately before upstream send, verifies both sockets run on the pre-existing egress worker, verifies the caller remains confined, and checks real timeout diagnostics, retained USD 0.0077824, zero settlement, and no dispatch on drive/reopen. Synchronized blocked-connect/read tests prove bounded caller return and no late DNS send without sleeping through real timeouts.

Podman inspection failed: the environment denies connecting to its local socket at 127.0.0.1:54307. No container or live inference was run. A real Linux unshare(CLONE_NEWNET) test is included for the privileged no-spend container qualification. The old notes' claim that code inspection disproves the incident is too strong: current child-only confinement does not establish the namespace of the historical failing thread. The regression confirms the supplied mechanism and fixes it; production causality still requires rerunning in the container.

Papercut logger reports this repo has not opted in, so no PAPERCUTS.jsonl was created. Git status uses core.fsmonitor=false. Two guessed file paths were absent; located the actual run-container.sh and left unrelated files alone.

## Final review before full verification

A focused shared-deadline probe showed a real race: a completed socket timeout could be replaced by the caller's later deadline check. Fixed by consuming completed worker results before checking remaining time and preferring a completed worker's exception before cancellation. The test now requires the original socket-timeout message. Interrupted the initial full suite intentionally at 51 passed/1 skipped to make this correction without changing source beneath running workflow identity checks, then restarted the requested full suite. Strict mypy passed again. Expanded the existing credential/network escape test to all three fixture backends: opencode, codex and claude-code. Native Codex/Claude profiles remain unqualified and fail closed as before.

Standalone `uv run mypy --strict` and `uv run pytest tests/vnext -q` start successfully. Compound commands with redirected logs, and an arbitrary `uv run python` proof command, hit the denied default uv cache. The proof script can use the already installed `.venv/bin/python`; no dependency changes or cache copies are required.

The standalone scripted proof passed and saved a sanitized ENETUNREACH diagnostic with distinct caller/worker namespaces. Its first isolated type check exposed the repository's test-package naming convention: mypy treats `tests/vnext` as `vnext`, not `tests.vnext`. Adjusted the proof's test import path accordingly; strict checking of the repository plus the proof script passes 191 files. `uv run pytest tests/live -q` skips the single paid acceptance test on this host. The full vnext run is progressing without unexpected failures.

## Existing run evidence

Opened all six local budget-stop-5c transport SQLite databases in read-only mode, selecting table names and call/response counts only. There are 13 actor and 18 user paid-dispatch records, each with a response reference; four other user databases have no calls. None has a diagnostics table. No raw request/response bytes or credentials were printed. This cannot establish the cause of the reported stall; earlier egress clearly cannot be treated as proof about the failing thread. Saved the counts in prior-run-audit.json. The proposed fresh proof run ID does not already exist locally.

## Final results

`uv run pytest tests/vnext -q` completed successfully: 534 passed, 25 skipped, 1 xfailed in 1280.65 seconds. `uv run mypy --strict` passes 190 source files; the additional proof-script check passes 191. The paid test skipped on the host. Final audit found all 30 frozen hashes unchanged, exactly the five intended source/test modifications relative to the pre-resume snapshots, no conflict markers, and a clean `git diff --check`. Saved the incremental git diff and final test summaries. No commit, PR, container run or live API call was made.
