# Parallax

Parallax starts with a small content-addressed domain and native-verifier core. This PR admits only GSM8K. It adds no Evolving Intent synthesis, experiment runner, provider adapter, campaign API, HUD integration, or Click recipe.

## What is committed

Every durable identifier uses canonical UTF-8 JSON and a preimage with an explicit `parallax-content-id`, version, namespace, and SHA-256 algorithm separator. Canonical values reject floats, non-string map keys, non-NFC text, unbounded integers, paths, bytes, and other platform-dependent objects.

A public task commits the source identity, prompt, and public asset manifest. It does not contain the answer authority, verifier commitment, sealed evaluator data, or sealed task ID. The sealed identity binds the public ID, native verifier commitment, and evaluator-data digest.

The verifier commitment binds:

- evaluator implementation bytes and exact-comparison policy
- parser implementation bytes and the final-line grammar
- answer authority digest
- individually digested assets and their provenance
- runtime and dependency policy
- record schemas and versions

Admission verifies these commitments before parsing or evaluation. Grading always returns one of `pass`, `task_failure`, `invalid_submission`, `harness_failure`, or `verifier_failure`. Expected model mistakes do not become verifier exceptions.

## GSM8K contract

The only accepted response form ends with exactly one line matching:

```text
FINAL_ANSWER: -?(0|[1-9][0-9]*)
```

Reasoning may precede that line. Extra markers, leading zeros, suffix text, missing markers, and oversized integers are invalid submissions. The evaluator compares the parsed canonical integer string with sealed answer authority.

Tests use labeled synthetic prompts and answers. No benchmark row or hidden answer is committed.

## Publication and replay

Public artifacts are built in a same-filesystem staging directory, verified against their canonical artifact manifest, and exposed with one atomic rename. The public tree policy allows only `task.json` and `publication-manifest.json`; it ignores nothing. Replay checks an immutable tree snapshot, rejects missing or unexpected files and all symlinks, re-runs admission, and verifies the locked verifier, assets, public identity, and artifact manifest before returning bytes.

See [`docs/architecture.md`](docs/architecture.md) for the record flow and invariants. [`docs/migration.md`](docs/migration.md) states what the clean stack retained or rejected from the evidence branch. The pinned upstream characterization and machine receipt live under [`characterization/`](characterization/).

## Run checks

From `parallax/`:

```shell
PYTHONPATH=src python -m unittest discover -s tests -v
python -m unittest discover -s characterization/tests -v
python -m py_compile src/parallax/*.py tests/test_core.py   characterization/characterize.py characterization/tests/test_characterize.py
```

Package and import checks:

```shell
python -m pip wheel --no-deps --no-build-isolation --wheel-dir /tmp/parallax-wheel .
PYTHONPATH=src python -c 'import parallax'
```

## Current limits

PR2 does not fetch GSM8K, synthesize trajectories, run experiments, claim Microsoft Evolving Intent parity, or support BIRD-SQL, BrowseComp+, or SWE-bench. The runtime policy commits CPython `>=3.11,<4` with no third-party runtime dependencies; it does not claim cross-interpreter equivalence. PR3 and PR4 must build on these identities without weakening admission or exposing sealed data.
