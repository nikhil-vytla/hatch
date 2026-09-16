# strive handoff

The current system is `src/strive`. Start with
[ARCHITECTURE.md](ARCHITECTURE.md), [the ADR index](adrs/README.md) and
[ROADMAP.md](ROADMAP.md). The architecture defines the five guarantees and the
implemented mechanisms; the roadmap distinguishes qualification from deferred
capabilities. The pre-vNext kernel has been removed; earlier ADR implementation
descriptions are historical, not the vNext API.

## Host workflow

From the project directory, use Python 3.12 or newer, uv and Deno:

```sh
uv sync --frozen
uv run mypy --strict
uv run pytest tests/vnext -q
uv run python -m strive.cli --help
```

The [root README](../README.md) creates and runs the recorded counter example.
Its provider makes no paid calls. Counter is separately packaged; install
`adapters/counter` or expose `adapters/counter/src` on `PYTHONPATH` for the CLI.
Tests arrange the lightweight adapter imports themselves.

In this restricted macOS workspace, automatic uv sync can hit a cache permission
error or a `system-configuration` panic before pytest starts. With the existing
synced environment, the tested workaround is:

```sh
UV_CACHE_DIR="$PWD/.cache/uv" UV_NO_SYNC=1 uv run mypy --strict
UV_CACHE_DIR="$PWD/.cache/uv" UV_NO_SYNC=1 uv run pytest tests/vnext -q
```

This reuses installed dependencies; it does not verify a fresh dependency sync.
Host skips can include Linux confinement, absent tau2, unqualified native CLIs,
funded smokes and restricted localhost sockets. The explicit expected failure is
`EvaluateFork` enactment. Do not report skipped gates as qualified execution.

## Linux verification

The Containerfile builds the runtime, seccomp filter and minimal jail rootfs.
It pins Python, uv and Deno versions; Debian packages resolve through the base
image's repositories, so the build is not a fully byte-reproducible package
snapshot. Image tags are not registry digest pins.

```sh
docker build --file Containerfile --tag strive .
mkdir -p .container-results
docker run --rm --privileged --cgroupns=private \
  --mount "type=bind,src=$PWD/.container-results,dst=/workspace/strive/.container-results" \
  strive
```

Inside an already prepared container, run `bash scripts/verify-in-container.sh`.
The outer container needs namespace support and writable delegated memory/pids
controllers. Its payload processes lose privileges inside the jail. Use the
private container cgroup namespace; do not expose the host's cgroup root or
Docker socket. Missing delegation is a failure, not a skip.

The entrypoint installs the pinned tau2 adapter in its own environment, prepares
retained data, checks the real jail, runs strict mypy and the full vNext suite,
and rejects skipped or missing required jail/tau2 gates. Outputs include logs,
JUnit results, dependency information, the generated tau2 lock and certificates
under `.container-results/`. The live tau2 checks use authored generations and
make no model calls. They exercise adaptive and fixed-stock certification,
upstream scoring, structured tool messages and mutation recovery.

Linux verification is separate from a funded benchmark run. See the
[tau2 guide](../adapters/tau2/README.md) for installation, certificates and the
fixed-stock runner. `--prepare-only` retains a fixed-stock plan without model
calls; execution requires its own authorized funding.

## Remaining gates

The manifest CLI currently composes the counter benchmark and recorded provider.
It rejects native harness campaign manifests. A functioning jail does not
qualify a vendor CLI's single-request behavior. Each native profile and the
adaptive telecom composition need their own evidence before a funded reference
campaign. That campaign also needs a retained workload closure, passing selected
task grading, provider reservation bounds, a funded ceiling and a protected
audit allocation.

Adaptive telecom uses 49/29/36 whole groups over 114 tasks. The separate
fixed-stock runner uses 40 published test IDs and a fresh upstream actor. Their
results have different populations and actor implementations. Feedback C and
`EvaluateFork` enactment remain unsupported.

## Core freeze maintenance

Permanent fixtures live in [tests/vnext/baselines](../tests/vnext/baselines/README.md).
The historical 21-file baseline stays unchanged. The current 30-file manifest
includes the intentionally updated contracts initializer docstring hash.

Three tests read these fixtures: the adaptation all-30-hashes test, the harness
baseline/adapter-selection test, and the second-benchmark operation/recovery
test. The harness test checks an exact five-file historical changed set:
`runtime/broker.py`, `runtime/supervisor.py`, `verify/engine.py`,
`contracts/manifest.py` and `contracts/__init__.py`, all under `src/strive`.
The initializer's sole change is its design-document pointer. The other four
entries reflect earlier approved admission, restoration and telemetry changes.
Never blanket-regenerate baseline hashes to hide unrelated drift.
