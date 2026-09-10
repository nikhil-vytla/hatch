Milestone 8 adds a buildable Linux verification stack, a runtime-qualified candidate and harness jail, and offline checks against the pinned tau2 installation. The macOS host can validate Python types, fallback behavior, frozen hashes and existing tests. Linux enforcement and live tau2 results must come from the orchestrator's container run. No image was built or run here, and no commit or PR was created.

Build and verify from the `strive/` directory:

```sh
docker build --file Containerfile --tag strive-m8 .
docker run --rm --privileged --cgroupns=private strive-m8
```

To retain the container's qualification report, generated adapter lock and test logs on the orchestrator:

```sh
mkdir -p .container-results
docker run --rm --privileged --cgroupns=private \
  --mount "type=bind,src=$PWD/.container-results,dst=/workspace/strive/.container-results" \
  strive-m8
```

Inside an already prepared container, run `bash scripts/verify-in-container.sh`. The outer runner needs privileges to create nested namespaces and delegate memory/pids controllers. The candidate and harness lose those privileges before their payload runs. Use a private container cgroup namespace; the script moves this container's supervising processes into a sibling leaf and creates `/sys/fs/cgroup/strive-jobs`. Do not bind the host's cgroup root or Docker socket into the container. An unavailable or read-only cgroup delegation causes verification to fail, not skip.

The definitions pin Python `3.12.12-slim-trixie`, uv `0.9.18`, Deno `2.9.5` and the Debian package snapshot `20251010T000000Z`. The root environment uses `uv sync --frozen`. Image tags are version pins, not registry digests verified by this host. The builder can replace them with its verified multi-architecture digests. The separate tau2 environment resolves against a fixed package upload cutoff and retains its generated lock for reuse; a complete transitive tau2 lock could not be generated on this host because shell GitHub DNS is unavailable.

The implementation files are:

- `Containerfile`, `.devcontainer/devcontainer.json` and `.dockerignore` define the image and development container. `.gitignore` excludes generated environments, source checkouts, retained data and results.
- `scripts/build-jail-rootfs.py`, `scripts/compile-seccomp.c`, `scripts/prepare-cgroup.py`, `scripts/install-tau2.sh`, `scripts/verify-in-container.sh` and `scripts/report-container-results.py` build the minimal runtime, install the adapter, prepare delegation and run verification.
- `src/strive/vnext/runtime/linux_jail.py`, `runtime/linux/_enter_cgroup.py`, `runtime/linux/_check.py`, `runtime/linux/seccomp.allow` and `runtime/confined_sandbox.py` implement the jail and candidate selection. The unfrozen CLI composition root selects this CandidateSandbox implementation.
- `src/strive/vnext/harness/process.py`, `profiles.py` and `process_identity.py` apply the same jail to harness launches and retain cgroup identities for recovery.
- `adapters/tau2/qualification_assertions.json`, `src/strive_benchmark_tau2/prepare.py` and `live_checks.py` add data preparation, a reviewed deterministic assertion allowlist and executable upstream checks. The adapter's client/process modules preserve the virtualenv interpreter symlink, and certification reports its complete scan count.
- `tests/vnext/test_linux_jail.py`, the conditional acceptance/sandbox/live-tau2 tests, the interpreter-path regression test and `tests/vnext/fixtures/tau2_recorded_generations.json` provide the probes and authored provider responses. Candidate test composition also selects the new implementation.

The jail uses [bubblewrap](https://github.com/containers/bubblewrap/tree/v0.11.0) and [cgroups v2](https://docs.kernel.org/admin-guide/cgroup-v2.html). Its enforcement is:

| Boundary | Applied mechanism and evidence |
| --- | --- |
| Hard memory | A fresh cgroup has `memory.max`, `memory.swap.max=0` and `memory.oom.group=1` written and read back before the trusted launcher joins it. Every fork then inherits membership. Candidate and harness default to 256 MiB; candidate settings can lower that. OOM probes require kernel `memory.events.oom_kill` and `memory.events.max` increments. Jailed candidate capture does not use the RSS watchdog. |
| Process count | `pids.max=64` for ordinary launches, covering threads and descendants. Attack probes use 16, require `fork()` to fail with `EAGAIN`, and require `pids.events.max` to increment. |
| Network and gateway | A new network namespace has only private loopback and no IP route. No host socket or DNS configuration is mounted. Harness model traffic uses the existing authenticated, effect-scoped inherited-pipe `/generation` endpoint; that pipe is its sole gateway route. There is no general HTTP proxy, veth or external IP exception. Candidate inputs use the existing bounded stdin protocol. |
| Syscalls | The committed `seccomp.allow` compiles through libseccomp into native-architecture cBPF. The default action is `EPERM`. Unknown architectures are killed. `clone` cannot request namespaces; `clone3` returns `ENOSYS` for libc fallback. Mounts, namespace entry, ptrace, kernel keyrings, BPF and io_uring are not allowed. Socket creation permits only UNIX/IPv4/IPv6 families; VSOCK, packet and netlink sockets are denied. |
| Filesystem | The image builds a runtime-only rootfs containing Deno, Python's standard library and their shared libraries. It excludes site-packages, the repository and host homes. The root and explicitly supplied payload files are mounted read-only. `/scratch` is a 16 MiB tmpfs and `/tmp` points there. Only four inert device nodes are supplied. Private procfs describes the jailed PID namespace; cgroup controls are absent. |
| Identity and privileges | Separate user, mount, PID, network, IPC, UTS and cgroup namespaces; one UID/GID mapping to 65534; no effective/permitted/inheritable/ambient capabilities; no-new-privileges; closed inherited descriptors and a new session. A trusted Python shim arms parent-death termination and joins the cgroup before bubblewrap forks. |
| Cleanup and recovery | `cgroup.kill` terminates the complete tree, including children that call `setsid()`. Cleanup waits for `populated=0` before removal. Harness launch records retain the unique cgroup name and boot identity before spawning; recovery uses that cgroup rather than a reusable process ID. |

Capability detection actually launches the complete jail and checks kernel-visible state. It verifies runtime file hashes, applies cgroup controls, runs the seccomp filter and inspects namespace identities, UID/GID maps, capabilities, no-new-privileges, mount flags, scratch capacity and routing. Every payload passes the same in-jail checks before exec. The qualified implementation pins the launcher, bubblewrap, filter, policy and runtime manifest. Once selected, a failed jail launch has no permission-only fallback. On macOS, the separate candidate implementation retains the original Deno permission sandbox and explicitly reports the OS floor as deferred. `STRIVE_REQUIRE_JAIL=1` makes a missing jail a hard error.

`production_os_confinement_floor` now requires a successful jailed candidate run. The Guarantee 1 acceptance test exercises native attacks through the shared jail and runs the actual candidate and fixture harness, including one successful recorded gateway dispatch and retained jail evidence. Native attack tests bypass Deno permissions and Python mocks. They assert denial of host-loopback and off-host connections, host credentials/home/keychain paths, writes outside scratch, symlink escape, kernel keyring access and namespace creation. Memory and fork bombs assert cgroup counters; scratch exhaustion requires `ENOSPC`; a child in a new session must die through recorded cgroup recovery. Missing capability skips these gates only outside the required container run.

The tau2 telecom extra remains isolated in `adapters/tau2/.venv`. Installation checks both distribution version `1.0.1` and [upstream commit a2c0247](https://github.com/sierra-research/tau2-bench/commit/a2c024725189473d2d7cea3a5cfdbcc67478e41f). Preparation copies original data and shared simulator guidelines from that exact checkout, keeps the MIT notice, records per-file hashes and refuses to overwrite a differing retained tree.

When tau2 is absent, live tests skip with an installation reason. When it is installed, missing data, a wrong pin or a broken evaluator fails. The tests run:

- Full inventory certification, including every task record's initialization, reference actions and allowlisted assertions; unique IDs; resolvable splits; disjoint 74/40 train/test whose union is base; deterministic grading; connected scenario groups and the whole-group 60/14 partition. Certification does not silently drop tasks or change denominators. Failure prints exact affected IDs; success records the total checked count.
- Comparator boundary cases plus success/failure scorer equivalence against upstream DB, environment-assertion, action and communication evaluators. Limit terminations also require zero reward.
- Real simulator operations backed by OperationStore, with authored actor and user provider responses. Separate interpreters exit immediately after agent and user mutation commits. Lookup and retry recover the original receipt without repeating a mutation; both databases and user/history/random/batch state survive snapshot/reopen; the production scorer rejects a missing receipt chain.

These are offline mechanism checks, not model-performance claims. The upstream user simulator receives injected responses at its actual generation hook. Socket dispatch is denied in the live-check and worker processes, and LiteLLM uses its local cost map. Existing fresh-interpreter verifier tests continue to reject runtime, jail, adapter and tau2 imports. All 30 core-freeze hashes remain unchanged, including `runtime/sandbox.py`, contracts, verifier and ledger. The separate candidate implementation uses the frozen interface without changing the freeze manifest.

The entrypoint installs tau2, checks that the jail can run, executes strict mypy and the full vNext suite, and rejects any skipped OS-jail or tau2 gate in the JUnit output. It writes logs, the installed dependency list, generated tau2 lock and qualification report beneath `.container-results/`, prints one final pass/fail summary and exits nonzero on failure. Vendor CLI qualification, funded live-model smokes and EvaluateFork enactment retain their separate pre-existing gates.

Host validation is recorded in `mypy-final.txt`, `pytest-vnext-final.txt` and `core-integrity.json`. The targeted run passed 36 tests with 12 capability/install skips; strict mypy passed 175 source files. The final full vNext host suite passed **443 tests, with 21 skips and 1 expected failure, in 893.48 seconds**. Source hashes match the snapshot retained during that run. The remaining expected failure is EvaluateFork enactment; the host skips include the Linux/tau2 gates, unqualified vendor CLIs, funded model smokes and localhost-TCP restrictions. Host checks use `UV_CACHE_DIR="$PWD/.cache/uv" uv run --no-sync ...` against the existing environment. An exact `uv run mypy --strict` attempt still hits the pre-existing macOS system-configuration panic during uv's automatic sync; `uv-host-sync-error.txt` retains that output. This is separate from the clean mypy result.

The first container run may expose a denied namespace or missing cgroup delegation in the orchestrator, a missing runtime syscall/shared library on aarch64, a registry tag or snapshot availability issue, or an upstream telecom task/assertion/grouping failure. These are failure conditions to inspect, not reasons to claim enforcement or certification. The container has not been executed here, so neither Linux qualification nor full live tau2 certification is claimed yet.
