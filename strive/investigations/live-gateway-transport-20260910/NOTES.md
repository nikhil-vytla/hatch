## Initial inspection

User forbids live calls, container runs, commits, and frozen-core changes. Worktree contains an existing uncommitted campaign implementation; preserved pre-edit copies of candidate files under /tmp for an incremental diff. All 30 frozen hashes match initially.

Campaign constructs OpenAITransport in the trusted parent. NativeServices launches only opencode_launcher.py/OpenCode under LinuxJail; ProcessServices reads pipe requests and calls gateway.dispatch synchronously in the parent. LinuxJail uses child-only bubblewrap --unshare-net and --clearenv. No gateway netns move is evident. Transport uses raw http.client.HTTPSConnection with one timeout capped at 60 seconds and erases OSError details. urllib versus http.client proxy behavior is another possible explanation for the reported GET/POST difference.

Git fsmonitor IPC failed during status; using core.fsmonitor=false. Papercut logger refused because repo has not opted in; no log was created.

## Observability first

Added a FULL-sync SQLite diagnostics table beside the existing dispatch audit. Upstream errors now record exception type, sanitized message, endpoint/stage, errno, HTTP status, elapsed time, process ID and calling-thread network namespace. The same JSON is emitted immediately on stderr before recovery. Error response bodies are never read; credential/request strings are redacted from exception messages. Count failures are recorded too, before a paid calls row exists. No ledger, retry, or recovery logic changed.

Code inspection disproves a gateway-in-jail bug in this checkout. The native gateway runs through ProcessServices._pipe_request -> ModelGateway.dispatch -> broker callback -> OpenAITransport.generate in the parent. The existing 60-second response timeout is shorter than the 150-second generation budget. A urllib probe also does not test the raw client's proxy routing. Official OpenAI error guidance identifies proxy, TLS, firewall, and timeout causes separately; its retry suggestions do not apply to this runner's stricter no-retry contract.

## Transport correction and regression checks

Kept OpenCode/candidate confinement unchanged. Added a calling PID and per-thread network-namespace guard to the live transport. The gateway now supplies its remaining deadline through a ContextVar; counting and generation share it, with one second left for harness exit. Connect timeout is at most 10 seconds; connected writes/reads use the remaining time. An absolute socket shutdown timer prevents slow response trickles extending the connected call. The OS resolver still controls blocking getaddrinfo latency before the socket exists; no claim is made that a socket timeout bounds DNS resolution itself.

Added HTTPS_PROXY/https_proxy and NO_PROXY/no_proxy handling on the trusted side using HTTP CONNECT with TLS verification to the fixed OpenAI host. No redirect, reconnect retry, or direct fallback was added. HTTPS-to-proxy and SOCKS schemes fail explicitly rather than being silently ignored. This addresses a concrete difference from the successful urllib probe, but proxy use in the failed container is not known from the supplied evidence.

Preserved the first upstream exception when a timed-out child closes its pipe. Added tests through the real transport with scripted sockets, plus campaign integration and parent PID/thread/netns assertions in the existing Linux native qualification. Initial test iterations caught a missing test CAS directory and an incorrect diagnostic category for incomplete HTTP bodies; both were corrected. Fast transport tests passed 27 cases. Campaign integration passed and verified suspension, retained $0.0077824 obligation, zero settled USD, and no redispatch after reopening. Strict mypy passed all 190 source files. Final expanded tests are running.

Expanded transport regression suite passed 30 tests in 15.03 seconds. Added a read-only diagnostic viewer and captured one real-code/scripted-socket failure record. Rechecked all 30 frozen hashes and generated an incremental patch. Packaging tests fail before building because the sandbox denies writes to the default uv cache. A writable /tmp cache reproduces the pre-existing uv 0.9.18 macOS system-configuration NULL-object panic, including offline mode and explicit proxy environment values. No test was weakened. Direct Hatchling is not installed in .venv; checking the existing read-only cache as an independent build path.

The independent wheel build succeeded using an existing cached Hatchling environment via PYTHONPATH, without downloading or copying dependencies into the project. Verified that deadline.py, openai_live.py, opencode_pipe.mjs, and policy assets are packaged. Added new transport tests to the container qualification command and checked shell syntax. Regenerated changes.patch from git diff --no-index against pre-session snapshots; the patch contains only this task's changes.
