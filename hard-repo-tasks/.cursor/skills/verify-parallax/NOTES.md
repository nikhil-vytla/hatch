# Verification skill notes

- The repository exposes a short-lived `parallax` console script and a Python
  library. It has no server lifecycle.
- `uv sync` prepares the root project. The optional HUD project has its own
  `hud_env/pyproject.toml` and lock file.
- The reproducible local baseline is the copied
  `tests/fixtures/synthesis_kernel/` family build followed by locked replay.
  The fixture contains a hand-authored frozen proposal with placeholder
  prompt/response digests and a `school_supply_sales` context that does not
  match the Natalia's clips source task. It does not execute or characterize
  Microsoft Evolving Intent generation, prove provenance integrity, or prove
  semantic proposal validity.
- Build evidence must retain both CLI actions, family IDs, artifact bytes, and
  complete SHA-256 lists outside the run scratch directory. New proof runs also
  retain a deterministic path-and-SHA-256 source manifest, relevant git status,
  and the tracked-diff digest against base HEAD.
- Repository compilation needs a clean checkout at the exact recipe revision.
  Grading needs a baseline tree captured before candidate edits. Export needs
  already compiled manifests and public artifacts.
- `parallax.run` accepts a caller-supplied synchronous or asynchronous model
  callback. It currently executes conversation arms only. Checkpoint execution
  raises `NotImplementedError`.
- The root HUD documentation uses `cd hud_env && uv sync && hud task list
  --source tasks.py`. HUD is a secondary path with separate dependencies and
  is not needed for the frozen-family baseline proof.
- The final cold-reader run completed through
  `prove-family-build.sh unit0-family-build-rerun`. The console script and
  source-tree import doctor checks passed. Both direct CLI builds returned
  family `5ebc593aee75327d17e2a9d01c2e8f86752566990c7eafeaee5c2dcb55469cf7`;
  each tree contained seven files with matching bytes and SHA-256 digests.
- The focused CLI replay test passed. Cleanup removed the run-specific scratch
  directory and left `evidence/unit0-family-build-rerun/` intact.
- No selected-path Doctor finding remains. `uv run hud task list --source
  tasks.py` also listed the current tasks when run from `hud_env`; using
  `--project hud_env` from the repository root does not change the source-path
  working directory and incorrectly looks for root `tasks.py`.
- The Click source checkout, optional Verifiers runtime, HUD rollout, provider
  calls, and external benchmark assets were outside this baseline drive and
  remain unproved.
- Helpers may compose direct commands into repeatable multi-command proof and
  evidence capture. They do not replace or redefine the direct CLI user path.
- A failed helper attempt retains only transcript/stdout/stderr and a small
  failure receipt before scratch removal. Partial stores, caches, credentials,
  and other scratch contents are not evidence.
- `unit0-family-build-provenance-20260802` recorded 27 exact source inputs,
  including untracked `src/parallax` files and copied config, against base HEAD
  `94e532d98b33250957d19d7d1e7d9ff09556d403`. Build and replay returned family
  `5ebc593aee75327d17e2a9d01c2e8f86752566990c7eafeaee5c2dcb55469cf7`,
  all three arm IDs matched, seven files matched byte-for-byte, and the focused
  test passed.
- `unit0-family-build-failure-20260802` deliberately hid `uv` from `PATH`.
  The launch failed with exit 127; the evidence directory retained only the
  failure receipt, transcript, stdout, and stderr, and its scratch directory
  was removed.
