# strive

Strive provides durable mechanisms for model-led adaptation. An agent can revise
its code, prompts and memory while a fixed execution core enforces permissions,
accounts for effects, records exact revisions and recovers without hiding
uncertainty. Policies decide whether a change helped; comparative evaluation is
optional.

The current implementation lives in `src/strive/vnext`. Read
[ARCHITECTURE.md](docs/ARCHITECTURE.md) for the five integrity guarantees and
[the ADRs](docs/adrs/README.md) for the decisions behind them.
[HANDOFF.md](docs/HANDOFF.md) has verification commands and qualification gates;
[ROADMAP.md](docs/ROADMAP.md) tracks remaining work.

The implementation includes immutable bundles, an authenticated journal and CAS,
pure verification, a serial supervisor and budget ledger, bounded candidate
execution, a Linux OS jail, and model harness adapters behind a single-request
gateway. `BenchmarkAdapter` separates task semantics and trusted scoring from
the core. Counter supplies deterministic workflow tests; tau2 telecom is the
first external benchmark, installed in a separate environment.

`ContinualRefine` operates, gathers authorized evidence, requests a proposal and
keeps, revises or restores a complete bundle. Feedback A/B and isolated final
audit control which evidence may influence adaptation. Journal-derived reports
and optional OTLP export with a Langfuse profile expose results and accounting.

## Run the recorded counter example

Use Python 3.12 or newer, uv and Deno. From this directory:

```sh
uv sync --frozen
export PYTHONPATH="$PWD/adapters/counter/src${PYTHONPATH:+:$PYTHONPATH}"
uv run python - <<'PY'
from pathlib import Path
from strive.vnext.cli.fixture import example
print(example(Path(".cache/counter-example")))
PY
uv run python -m strive.vnext.cli --root .cache/counter-runs \
  run .cache/counter-example/counter.toml --id adapting-17
uv run python -m strive.vnext.cli --root .cache/counter-runs status adapting-17
uv run python -m strive.vnext.cli --root .cache/counter-runs resume adapting-17
```

The example uses recorded responses and makes no paid calls. Run IDs are unique;
resume reuses the original bindings and retained state. The manifest CLI also
provides `experiment`, `compare` and `project`; `--help` lists their arguments.
The installed `strive` command delegates directly to vNext; there is no
separate legacy CLI or run format.

## Current limits

The CLI currently composes the counter adapter and recorded provider. It rejects
native harness campaign manifests. Native CLI single-request drives, Linux jail
qualification on the executing host, installed tau2 grading/recovery checks and
funded campaigns are separate gates. Host Deno permission tests do not establish
the Linux confinement floor.

Adaptive telecom uses whole scenario groups with 49 development, 29 validation
and 36 audit tasks. Its separate fixed-stock runner uses the original 40 test
IDs and an upstream fixed actor. These modes have different populations and
implementations; their scores are reported separately. See the
[tau2 adapter guide](adapters/tau2/README.md).

`EvaluateFork` enactment and private-veto feedback C remain deferred. A valid
execution history can contain failures, unknown outcomes and budget overruns.
No fixture result establishes live-model improvement.

## Verify

```sh
uv run mypy --strict
uv run pytest tests/vnext -q
```

The [handoff](docs/HANDOFF.md) documents the local-cache/no-sync workaround for
restricted macOS environments and the required Linux container checks. Core hash
fixtures live in [tests/vnext/baselines](tests/vnext/baselines/README.md).
