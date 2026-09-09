# Langfuse-only release 1 telemetry

Release 1 now exposes only the Langfuse reference profile. LangSmith and Phoenix mappings and enum members are removed. Both authored and resolved manifest validation reject those values with an error naming the unsupported profile, the supported `langfuse` option, and the deferred profiles. The Langfuse mapping preserves vendor-neutral OTLP GenAI 1.41.0 and `strive.*` attributes. CLI choices follow the enum automatically; examples and fixtures already used Langfuse.

Changed files:

- [profiles.py](../src/strive/vnext/telemetry/profiles.py): removed the two deferred vendor mappings.
- [manifest.py](../src/strive/vnext/contracts/manifest.py): reduced the enum and added the validation error.
- [test_telemetry.py](../tests/vnext/test_telemetry.py): retained Langfuse, neutral attribute, outage/rebuild, duplicate prevention, journal-fold, metrics and execution dependency coverage; added rejection checks for both deferred profiles in both loaders.
- [ASTRA_DESIGN.md](../docs/ASTRA_DESIGN.md): updated section 8.2, release scope, the workflow milestone and Amendment 1's observability reference.
- [second-benchmark-core-freeze.json](../m5-investigation/second-benchmark-core-freeze.json): refreshed only the manifest entry.
- [test_harness.py](../tests/vnext/test_harness.py): added the explicitly approved manifest trim to the older freeze guard's exact list of allowed differences.

The baseline change is legitimate because the human explicitly approved this core contract trim. The manifest SHA-256 changed from `36ae490a85795a4c58a29535b4bd44799c4a105263a4bacf1535c306f9a1fc44` to `7cfe64182077324efb3f9818f7933f403689e7b23810de51b1788490a8bc55f4`. All 30 current hashes match; the other 29 baseline entries and files are unchanged. The older M4 baseline and historical integrity snapshots remain intact. Verifier, ledger, gateway, broker, supervisor and admission logic match HEAD.

Final validation:

| Check | Result |
|---|---|
| Full vNext suite, all 454 cases | **441 passed, 10 skipped, 3 xfailed, 0 failed** |
| Guarantees 2–5 | All passed |
| Both freeze guards | Passed |
| Focused telemetry and freeze checks | 9 passed |
| `uv run mypy --strict` | No issues in 168 source files |
| `git diff --check` | Clean |

The three xfails are exactly guarantee 1's native harness confinement, the production OS confinement floor, and deferred EvaluateFork. The first sequential suite found only the older freeze guard mismatch. After that correction, the final run used four isolated pytest processes and verified that each collected vNext case ran exactly once. Each process exited successfully; the longest took 257.76 seconds. See the [combined result](pytest-vnext-final.txt), [JUnit evidence](pytest-vnext-final.xml), individual `pytest-final-*.txt` logs and [mypy output](mypy.txt).

Validation used the existing environment with the repository's documented uv workaround:

```sh
export UV_NO_SYNC=1 UV_OFFLINE=1
export UV_CACHE_DIR="$PWD/langfuse-profile-trim/.uv-cache"
uv run mypy --strict
uv run python langfuse-profile-trim/rerun_vnext.py
```

The [runner](rerun_vnext.py) collects the complete suite and uses the retained first-run timings to distribute cases. It adds no dependencies. The [patch](changes.diff) contains all six tracked-file changes. All work is under `strive/`; no commit, PR, staging or git history change was made.
