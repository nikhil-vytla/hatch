# Live gateway transport diagnosis

The gateway already runs on the trusted container side. `Campaign` constructs `OpenAITransport` in its parent process; `NativeServices` launches only the OpenCode launcher in `LinuxJail`. `ProcessServices._pipe_request` handles the child's inherited pipe in the parent, then calls `ModelGateway.dispatch`, the broker's forwarding callback, and `OpenAITransport.generate`. The jail still uses `--unshare-net`, `--clearenv`, seccomp and cgroups. No candidate/harness networking or credential access was added.

Two concrete transport defects were identified. Both input counting and generation previously used an independent timeout capped at 60 seconds, despite the 150-second harness deadline. The raw HTTPS client also ignored environment proxy routing that the successful `urllib` probe would use. The original exception was discarded, so the supplied evidence cannot establish whether this particular run failed on DNS, TCP/TLS, counting, or generation response reading. The roughly 40-minute elapsed run is not proof of repeated calls; setup work also has long timeouts and the campaign already suspends after an ambiguous dispatch. No container or live API call was run during this investigation.

The [transport fix](../../src/strive/vnext/harness/openai_live.py) sets the socket connect timeout to at most 10 seconds and gives connected writes/reads the remaining generation time. The [gateway](../../src/strive/vnext/harness/gateway.py) passes its existing deadline through a [ContextVar](../../src/strive/vnext/harness/deadline.py), so startup, counting and generation consume the same window. One second is reserved for the harness to read the reply and exit. A socket shutdown timer bounds a slow connected response. The manifest, model/output limits, budget and 150-second harness deadline are unchanged. Blocking OS DNS resolution before a socket exists remains governed by the system resolver; a socket timeout does not bound `getaddrinfo` itself.

The trusted transport now honors `HTTPS_PROXY`/`https_proxy` and `NO_PROXY`/`no_proxy` for HTTP CONNECT proxies, with TLS verification to the fixed `api.openai.com` destination. Proxy authentication stays on CONNECT; the OpenAI key and prompt are sent only inside the TLS connection. Unsupported HTTPS-to-proxy or SOCKS schemes fail explicitly. There is no redirect following, retry, or direct fallback. A PID and per-thread network-namespace guard refuses dispatch if a transport is moved out of its owning context. This guards the already-correct boundary; it does not claim that a namespace identity alone proves internet access.

Failures now appear immediately on stderr and in `transport/<role>/transport.sqlite`, table `diagnostics`, inside the mounted run directory. Each JSON record includes operation key, endpoint, phase, exception type and redacted message, errno, HTTP status, failure category, elapsed time, configured connect/read timeouts, deadline expiry, route, and current/owner PID and network namespace. HTTP error bodies are not read. Credentials and request strings are removed from exception messages. The [pipe handler](../../src/strive/vnext/harness/process.py) preserves the upstream exception if the child exits and writing the error reply raises EPIPE. The original calls table, retained reservations, single dispatch, and suspend-on-ambiguity recovery remain intact.

The [new tests](../../tests/vnext/test_openai_live_transport.py) execute the real transport using scripted connections. They cover counting and paid-call failures, DNS, TLS, connect/read timeout, network unreachable, lost/truncated responses, HTTP 302/401/429/500, redaction, proxy/no-proxy behavior, no fallback, and rejection after a PID/netns move. A virtual 90-second generation succeeds under the unchanged 150-second budget; another test proves counting consumes the remaining harness deadline. Campaign integration checks the upstream PID against the actual harness child PID, retains the real timeout cause, and verifies SUSPENDED, zero settled USD, a $0.0077824 obligation, and zero further sends after reopening. The existing Linux native qualification now also asserts that actor/user provider callbacks stay in the original parent PID/thread/netns. Linux kernel confinement tests remain for the orchestrator.

The final transport suite passed **30 tests** in 16.60 seconds; [strict mypy](mypy.txt) passed all 190 configured source files. The diagnostic viewer passed strict mypy separately. The [independent wheel build](wheel-build.txt) passed and included the new module. Broader host results are recorded below after completion. The incremental [patch](changes.patch) is against this session's starting worktree, which already contained uncommitted campaign work. It excludes unrelated existing changes and fetched code. [All 30 frozen-core hashes match](frozen-core-check.json), and no frozen source or baseline was edited. No commit or PR was created.

Rebuild and qualify from the repository root. These commands are for the orchestrator:

```sh
podman build -t strive-vnext -f Containerfile .
podman build -t strive-live -f live-tau2-budget-proof/Containerfile.live .
podman run --rm --privileged --cgroupns=private \
  -v "$PWD/live-results:/results" strive-live qualify
```

Run the unchanged five-cent proof with a fresh ID. The prior suspended run and its reservations must remain retained; source closure checks prevent resuming it with this implementation.

```sh
podman run --rm --privileged --cgroupns=private \
  -e OPENAI_API_KEY -e HTTPS_PROXY -e https_proxy -e NO_PROXY -e no_proxy \
  -v "$PWD/live-results:/results" strive-live \
  budget-stop-live live-tau2-budget-proof/budget-stop-5c.toml \
  --id budget-stop-5c-transport-20260910
```

Success must produce `live-results/runs/budget-stop-5c-transport-20260910/budget-proof.json` with `status: passed`, `live: true`, real provider receipt IDs, reconciled spend at or below $0.05, zero unknown USD/overruns, and `dispatches_after_stop: 0`. A transport failure must still fail this proof and suspend; diagnostics do not convert it into success. Read the durable errors without loading prompt artifacts:

```sh
python3 investigations/live-gateway-transport-20260910/show_transport_errors.py \
  live-results/runs/budget-stop-5c-transport-20260910
```

The [scripted example](scripted-diagnostic.jsonl) shows the same path after an injected read timeout. [OpenAI's error guidance](https://developers.openai.com/api/docs/guides/error-codes#python-library-error-types) distinguishes connection/proxy/TLS failures from timeouts; its generic retry advice was deliberately not applied to this runner.
