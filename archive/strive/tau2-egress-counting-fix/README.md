# Counting and generation use one egress worker

The local counting path was `OpenAITransport._generate -> _post("/v1/responses/input_tokens") -> _serve -> _exchange -> _connection`. `_connection` selected `route="direct"` when no HTTPS proxy applied. In this checkout, both endpoints already used a worker queue; the old route label described proxy selection, not whether the worker ran. The concrete weakness was that each transport created its own worker and trusted its own construction-time namespace, without waiting for worker readiness. A transport initialized after jail entry could therefore accept that jailed namespace as its owner. The supplied container evidence establishes a confined counting call, but does not identify a separate direct-counting branch in this source.

[OpenAIEgress](../src/strive/vnext/harness/openai_live.py) owns the shared queue and thread. [live()](../src/strive/vnext/cli/campaign.py) creates it before jail qualification and passes the same instance to every actor/user transport. The default Campaign provider factory also shares one worker. Linux threads inherit their creator's network namespace when started, so starting this worker during trusted setup retains the container's original egress namespace without changing the caller's namespace. A Future acknowledges the worker's PID/thread/netns check, and setup waits at most 10 seconds for readiness before proceeding. No HTTP readiness probe or paid call is made. Missing Linux namespace identity fails closed.

Both counting and generation submit to that queue. Every exchange and connection creation checks the captured PID, worker thread, and namespace. There is no caller-thread HTTP fallback. Diagnostics now say `route="egress_worker"`, with `proxy_route="none"` or `"http_connect"` and an explicit `egress_netns`. Proxy authentication, TLS, credential redaction and request redaction are preserved. Connect remains capped at 10 seconds and connected reads at 60 seconds, within the original shared generation deadline. A stalled worker refuses further submissions across transports; shutdown remains bounded and cancelled late connections never send.

The [deterministic tests](../tests/vnext/test_openai_live_transport.py) model Linux thread namespace inheritance. They create two transports after the caller enters gateway-only confinement, then assert the counting/generation paths run on the same original egress thread in its original namespace. Other checks hold worker initialization until namespace readiness, reject the wrong startup namespace, forbid caller-thread connections, and reject a worker namespace change between counting and generation. Campaign recovery is exercised at both endpoints, preserving the outstanding USD 0.0077824 reservation, SUSPENDED state, and zero redispatches after drive/reopen. All connections are scripted; the host tests disable external networking.

No candidate or harness jail code, ledger, broker, recovery rule, price, budget, model controls, or frozen baseline changed. [All 30 frozen hashes match](frozen-core-check.json). The [incremental patch](changes.patch) contains only this session's two source files and one test file, relative to the pre-existing dirty worktree. No container was invoked, no live API call was made, and no commit was created.

Strict mypy passes all 190 configured files. The final transport suite plus campaign exact-ceiling/restart check passes 40 tests, with one Linux-only skip. An earlier run correctly rejected resume after a source edit overlapped the test; the stable-source rerun passes. Results are recorded in [mypy.txt](mypy.txt), [transport-tests.txt](transport-tests.txt), and the notes. The full host suite passes **839 tests**, with 26 skips and one expected xfail, in 1261.11 seconds. See [host-tests.txt](host-tests.txt). The focused stable-source run also covers the final two added worker-boundary checks.

Rebuild the live image from this tree, then rerun with a fresh ID. Retain the previous suspended run and its reservation. Run from the repository root with OPENAI_API_KEY already exported:

```sh
podman build -t strive-live -f live-tau2-budget-proof/Containerfile.live .
podman run --rm --privileged --cgroupns=private \
  -e OPENAI_API_KEY -e HTTPS_PROXY -e https_proxy -e NO_PROXY -e no_proxy \
  -v "$PWD/live-results:/results" strive-live \
  budget-stop-live live-tau2-budget-proof/budget-stop-5c.toml \
  --id budget-stop-5c-egress-counting-20260910
```

This uses the existing strive-vnext base image. If absent, build it first with `podman build -t strive-vnext -f Containerfile .`. The no-spend container qualification remains `podman run --rm --privileged --cgroupns=private -v "$PWD/live-results:/results" strive-live qualify`. Success requires budget-proof.json with status passed, live true, settled spend at most USD 0.05, zero unknown/overrun USD, and zero post-stop dispatches. Host simulation establishes routing and recovery behavior; real Linux namespace and egress validation remain for the orchestrator's container rerun.
