---
name: verify-parallax
description: Verify Parallax through its current CLI and Python library paths, capture durable proof, and diagnose local setup before changing repository-task or synthesis behavior.
---

# Verify Parallax

Use this skill from the `hard-repo-tasks` repository root. Drive a current
user command or public library call. Do not add a production verification
command and do not describe target architecture as implemented behavior.

## Launch

Parallax is a short-lived CLI and library, not a server. Prepare the root
project once:

```bash
cd /Users/nikhil/work/hatch/hard-repo-tasks
uv sync
```

`uv sync` is ready when it exits zero. Each drive must use a run-specific
scratch directory. Never write locks or stores into
`tests/fixtures/synthesis_kernel/`. No process remains to tear down after a CLI
command exits.

The HUD adapter is secondary and has a separate project. Prepare it only when
driving the HUD map entry:

```bash
cd /Users/nikhil/work/hatch/hard-repo-tasks/hud_env
uv sync
```

## Doctor

Run these read-only checks from the repository root before driving the primary
CLI or library:

```bash
uv run parallax --help
uv run python -c 'import parallax; print(parallax.__file__)'
test -f tests/fixtures/synthesis_kernel/experiment.toml
test -f tests/fixtures/synthesis_kernel/gsm8k.json
test -f tests/fixtures/synthesis_kernel/proposal.json
```

The help output must list `compile`, `grade`, `export`, and `build`. The import
path must resolve under this checkout. For the family-build drive, all three
fixture checks must pass.

Run feature-specific checks only when needed:

- Compile needs `git`, a clean source repository, and its exact pinned commit.
- Grade needs a candidate tree, the matching recipe, and a baseline tree
  captured before candidate edits.
- Export needs compiled public artifacts and their manifest files. Verifiers
  package loading additionally needs `uv sync --extra verifiers`.
- HUD listing needs `cd hud_env && uv run hud task list --source tasks.py`.
- Conversation execution needs a caller-supplied sync or async model callback.

If `uv run parallax` is unavailable but the import check succeeds, record that
doctor failure and use the supported source-tree form:

```bash
PYTHONPATH=src uv run python -m parallax.cli --help
```

Do not install into a user or global Python environment.

## Drive

Use the real `parallax` console script. The pinned offline family drive copies
its inputs, builds once, and rebuilds from the generated lock:

```bash
RUN_ID=manual-family-build
SCRATCH=".cursor/skills/verify-parallax/.scratch/$RUN_ID"
mkdir -p "$SCRATCH/config"
cp tests/fixtures/synthesis_kernel/{experiment.toml,gsm8k.json,proposal.json} \
  "$SCRATCH/config/"

uv run parallax build "$SCRATCH/config/experiment.toml" \
  --store "$SCRATCH/build"
uv run parallax build --locked "$SCRATCH/config/family.lock" \
  --store "$SCRATCH/replay"
```

Parse both JSON results. The `family_id` and all three arm task IDs must match.
Compare every file under `build/<family_id>/` with the corresponding replay
file. The supporting focused test is:

```bash
uv run pytest -q \
  tests/test_synthesis_kernel.py::test_cli_build_reruns_idempotently_and_replays_lock
```

This drive proves current family construction, admission, publication, and
locked replay from a hand-authored frozen proposal. The proposal contains
placeholder digest-shaped strings and a known `school_supply_sales` versus
Natalia's clips mismatch. The proof establishes artifact determinism for the
exact manifest-bound bytes, not proposal provenance integrity, semantic
validity, Microsoft Evolving Intent extraction, counterfactual generation,
predecessor generation, scheduling parity, or paper-result reproduction.

See `features/README.md` for the other current commands and library path.

## Evidence

Store durable proof under:

```text
.cursor/skills/verify-parallax/evidence/<run-id>/
```

For a family build, retain:

- a transcript with each command, stdout, stderr, and exit code;
- the first-build and locked-replay JSON output;
- the copied config and generated `family.lock`;
- both emitted artifact trees;
- a receipt naming the family ID, arm IDs, command path, and claim limit;
- a deterministic source manifest covering the current package, lock,
  production source tree, copied config, helper, and focused test by relative
  path and SHA-256;
- relevant git status plus the SHA-256 of the tracked diff against base HEAD;
- complete SHA-256 digests for both artifact trees;
- the focused pytest output as supporting evidence.

Proof must include the user command and resulting files. A pytest pass alone is
not proof. Evidence may contain sealed fixture data, so keep it local and small.
Do not copy credentials, provider responses, fetched repositories, caches, or
large binary assets.

If a command fails, retain only its transcript, captured stdout/stderr, and a
small failure receipt under the requested evidence ID before removing scratch.
Never publish partial stores, dependency caches, environment files, credentials,
or other scratch contents as failed-run evidence.

## Cleanup

Remove only the scratch directory created for the run:

```bash
rm -rf ".cursor/skills/verify-parallax/.scratch/$RUN_ID"
test ! -e ".cursor/skills/verify-parallax/.scratch/$RUN_ID"
test -d ".cursor/skills/verify-parallax/evidence/$RUN_ID"
```

Never kill by process name. The current CLI leaves no service running. Do not
remove the evidence directory during cleanup.

Compile and grade checks execute recipe commands in temporary copies, but those
commands are still arbitrary repository code. Use trusted pinned inputs and
the containment required by that feature. HUD and provider-backed runs have
their own runtime and network boundaries. This skill's baseline helper does
not claim those boundaries.

## Helpers

`prove-family-build.sh` performs Launch, Doctor, the copied-fixture CLI drive,
artifact comparison, focused pytest support, evidence publication, and scratch
cleanup:

```bash
.cursor/skills/verify-parallax/prove-family-build.sh unit0-family-build
```

The helper composes repeatable multi-command proof and evidence capture around
the direct CLI path; it does not replace the two direct `parallax build`
commands above. It refuses an existing run ID so it cannot overwrite evidence
or share scratch state with another run. A successful run publishes the full
receipt and artifact set. A failed run publishes only the transcript,
stdout/stderr, and failure receipt before removing its run-specific scratch.
