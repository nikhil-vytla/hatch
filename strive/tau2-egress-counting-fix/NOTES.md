# Work notes

- Scope: unify counting and generation egress; no container, live calls, or commit. Preserve the existing dirty worktree. Baselines of edited files are saved outside the repository in /tmp/strive-egress-counting-before.
- All 30 hashes in tests/vnext/baselines/second-benchmark-core-freeze.json match before editing.
- Local path: OpenAITransport._generate -> _post("/v1/responses/input_tokens") -> per-transport queue -> _serve -> _exchange -> _connection. Generation follows the same path. _connection sets route="direct" when HTTPS_PROXY is absent/bypassed; the old field describes proxy choice, not thread routing. No separate caller-thread counting path exists in this checkout.
- Current weakness: every transport independently captures network_namespace() in __init__, starts its own worker, and does not await readiness. A transport created in a confined namespace can bless that namespace as its owner. The supplied diagnostics demonstrate failed egress for counting, but the route label alone cannot establish a queue bypass in this source.

- Implemented OpenAIEgress with a startup Future acknowledgement, a single queue, worker-thread/PID/netns checks, and bounded shutdown. live() creates it before require_capability() and passes it to every actor/user transport. Default Campaign composition also shares one worker. Proxy choice is now proxy_route; route is egress_worker.
- Added deterministic coverage for two transports constructed after simulated jail entry, readiness blocking, startup namespace mismatch, and counting-stage campaign suspension alongside generation-stage suspension.
- Tool friction: redirected uv invocations with a /tmp cache hit the known macOS system-configuration NULL-object panic. The exact standalone `uv run mypy --strict` succeeds for all 190 files; exact standalone pytest starts successfully. Git fsmonitor warnings are avoided with -c core.fsmonitor=false. Papercut CLI declined to log because the parent repository has not opted in; no opt-in file was created.

- Final socket-only transport suite: 37 passed, 1 Linux-only skip, 2 campaign cases deselected, in 4.92 seconds. Strict mypy remains clean for all 190 files. Added checks that caller-thread connection creation is refused and worker namespace drift between counting and generation prevents the second connection.
- Full host suite and combined transport/campaign suite are running. The combined run has reported one failure; its traceback is pending the run summary. Some source changes overlapped the initial campaign tests, so implementation-closure checks may require a clean rerun after source stabilization.

- Initial combined run completed: 47 passed, 2 skipped, 1 failed in 206.75 seconds. The only failure was test_campaign_exact_ceiling_stop_and_restart_no_dispatch rejecting resume because runtime source changed during the run. Both new counting/generation campaign recovery cases passed. A rerun of the entire transport file plus that restart case is underway with source held stable. Full host suite is also continuing with no failures reported so far.

- Stable-source rerun passed: entire transport file plus campaign exact-ceiling/restart check, 40 passed and 1 Linux-only skip in 56.36 seconds. The earlier failure required no code change; it was the expected rejection of a changed runtime closure.

- Full host validation completed successfully: `uv run pytest tests -q`, 839 passed, 26 skipped, 1 xfailed in 1261.11 seconds. No unexpected failures. The full run began before the last two test additions; the stable-source focused run covers both additions and the final transport source.
- Final artifacts: README.md report, concise _summary.md, incremental git changes.patch, strict mypy/transport/host results, and before/after frozen-core checks. Only openai_live.py, campaign.py, and test_openai_live_transport.py were edited in this session. No container, live API call, frozen core change, or git commit.

- Final patch and whitespace checks pass. One combined check initially ran git diff from the non-repository snapshot directory; rerunning diff in the repository and apply-check in the snapshot directory succeeded.
