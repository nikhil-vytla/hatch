# Amendment 3 split recalibration

Amendment 3 is implemented on `strive-astra`, building on the existing worktree. The certifier uses direct base-scenario groups for the adaptive split and reports stock-split overlap as informational. Selected-task deterministic grading remains blocking. No tau2 installation, tau2 execution, container execution, commit, PR, or history change was performed on this host.

The grouping key is the pinned generator's `[name]` base-template stem. Persona suffixes and composed failure conditions normalize to that root. Shared goals, initial state, words, or failure-condition tokens never connect roots. The [pinned TaskManager](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/src/tau2/domains/telecom/tasks/manager.py) names three templates. Non-generator contract fixtures use exact canonical persona-free scenario equality.

| Partition | Root | Actual tasks | Target |
| --- | --- | ---: | ---: |
| Development | `[mms_issue]` | 49 | 60 |
| Validation | `[service_issue]` | 29 | 14 |
| Audit | `[mobile_data_issue]` | 36 | 40 |

All 114 selected base IDs appear exactly once. Exact 60/14/40 is impossible with these roots. The allocator preserves three nonempty partitions when at least three groups exist, then minimizes total absolute size error, maximum error, audit/validation/development errors, and development/validation sizes. A stable SHA-256 order of the seed plus root and deterministic DP traversal settle ties. Without the nonempty requirement, minimum total size error would produce 65/0/49 and eliminate validation. The implemented three-way split avoids that loss while preserving every group. With fewer than three groups, it reports empty partitions explicitly.

[derived-split.json](derived-split.json) retains exact selected IDs, root mappings, seed/order, target/actual counts, and source provenance. [analyze_evidence.py](analyze_evidence.py) reproduces the allocation from published train/test ID arrays without importing tau2. Its larger map contains the captured crossing IDs; it is not a new host scan of task definitions. Linux certification will retain the complete task bytes and complete group mapping.

Only three independent roots remain, so this is a coarse transfer experiment across scenario families. It cannot support claims about many independent held-out scenarios, and the Strive-derived adaptive split has no leaderboard comparability claim. The grouping rationale follows [GroupKFold](https://scikit-learn.org/stable/modules/cross_validation.html#group-k-fold).

The captured stock train/test overlap contains **2,285 IDs**, comprising 1,984 MMS, 254 mobile-data, and 47 service IDs. Every selected stock train/test ID is in that captured set. Certification retains two diagnostics, `stock_split_cross_group` for direct roots and `stock_split_legacy_cross_group` for the old closure. Both include counts/IDs and `severity="informational", fatal=false`. The legacy diagnostic never supplies adaptive groups or blocks their certification.

Every selected headline task must resolve and pass explicit deterministic reward-basis checks, absence of NL assertions, the reviewed assertion allowlist, strict initialization/reference replay, and assertion execution. Failures retain exact IDs and block certification. The adaptive partition also has a blocking coverage/disjointness check. Unselected inventory records receive a structural grading scan with separate informational findings. No selected task is excluded to make the gate pass.

The new `fixed-stock` mode selects the original 40 `test` IDs in published order with no group-disjointness gate. It has its own strict grading certificate. [fixed_stock.py](../adapters/tau2/src/strive_benchmark_tau2/fixed_stock.py) runs an initial upstream `llm_agent` from an explicit retained model/options artifact, creating fresh actors per simulation with no refiner or cross-episode learned state. This executable baseline does not port an opencode actor. It pins the user to `gpt-4.1-2025-04-14`, temperature `0.0`, and retains actor options, trials, seeds, resolved upstream configuration, raw results, and a separate summary. Missing rewards or missing/duplicate/substituted task/trial results fail completion. `--prepare-only` retains a plan without model calls.

Stock-test comparability requires the same task population and settings. [Upstream split guidance](https://github.com/sierra-research/tau2-bench/blob/a2c024725189473d2d7cea3a5cfdbcc67478e41f/README.md) identifies `base` as the original leaderboard denominator. A 40-task stock test result is not a 114-task base leaderboard score, and it must not be pooled with adaptive results or reused as adaptive feedback. Actor-implementation differences also preclude a matched cross-mode claim.

The edited source/config files are:

- `adapters/tau2/src/strive_benchmark_tau2/splits.py`, `qualification.py`, and `certify.py`: direct-root grouping, deterministic allocation, selected-task gates, mode selection, retained certificate version 2 and informational diagnostics.
- `adapters/tau2/src/strive_benchmark_tau2/fixed_stock.py`: fixed initial-actor execution and separate coverage/result reporting.
- `adapters/tau2/src/strive_benchmark_tau2/adapter.py` and `server.py`: root identities in TaskSpec, mode-specific split declarations, and explicit loading of version 2 certificates. Old certificates must be requalified; their meanings are not silently changed.
- `adapters/tau2/src/strive_benchmark_tau2/live_checks.py`, `tests/vnext/test_tau2_live.py`, and `scripts/report-container-results.py`: both live certification modes, real fixed-runner configuration validation, and a required fixed-stock container gate. All five live tests skip on macOS.
- `tests/vnext/test_benchmark_qualification.py`, `test_tau2_fixed_stock.py`, and `benchmark_fixtures.py`: direct-group and allocation regressions, strict grading failures in both modes, informational overlap, initial-actor execution, complete trial coverage, and matching fixture group identities.
- `docs/ASTRA_DESIGN.md` and `adapters/tau2/README.md`: Amendment 3, §7/§9.4 updates, actual denominators, group-aware holdout rationale, two-mode usage and comparison limits.

The incremental [changes.patch](changes.patch) contains only this pass's changes against the starting worktree and passes reverse-application checking. [scope-verification.json](scope-verification.json) confirms all **30 core-freeze hashes match**, every pre-existing `src/strive/vnext` file is unchanged, and the jail plus the MultiToolMessage worker and regressions are unchanged. The initial full scope audit checked 42,966 existing files; the retained compact baseline contains 237 source/config hashes. No frozen contract or prohibited core file was edited.

Host validation records **79 passed, five skipped** in the focused run and clean strict mypy for **179 source files**. The actual checker command was `UV_CACHE_DIR="$PWD/.cache/uv" UV_NO_SYNC=1 uv run mypy --strict`. Plain automatic-sync uv still aborts in the previously captured macOS SystemConfiguration panic before launching mypy. Both unchanged packaging tests reproduce that same panic in `uv build`, including offline/proxy probes. No packaging check was weakened or skipped. The final full host suite finished with **772 passed, 22 skipped, one expected failure, and two failed**, in 1,136.43 seconds. The failures are only `tests/test_packaging.py::test_wheel_ships_package_data` and `tests/test_packaging.py::test_installed_console_script_runs_in_isolated_env`, both aborting in uv before packaging executes. This is not a fully green host suite. See [validation.json](validation.json), [full test output](host-suite.txt), and [JUnit results](host-suite.xml).

Rebuild and verify on the Linux orchestrator, from the `strive/` directory:

```sh
docker build --file Containerfile --tag strive-m8 .
mkdir -p .container-results
docker run --rm --privileged --cgroupns=private \
  --mount "type=bind,src=$PWD/.container-results,dst=/workspace/strive/.container-results" \
  strive-m8
```

The image entrypoint runs `bash scripts/verify-in-container.sh`, including strict mypy, required jail/Guarantee 1 checks, both tau2 certification modes, scorer equivalence and mutation recovery. Results include `.container-results/tau2-certificate/qualification.json` and `.container-results/tau2-fixed-stock-certificate/qualification.json`. All expected Linux/tau2 gates must execute rather than skip. Actual grading qualification and the preserved codec fix still require this Linux rerun; the host ID analysis does not claim to certify them.

A funded fixed-stock performance run is separate from verification. Prepare its initial actor JSON as shown in [the adapter README](../adapters/tau2/README.md), then run in the pinned Linux adapter environment:

```sh
adapters/tau2/.venv/bin/python -I -B -m strive_benchmark_tau2.fixed_stock \
  adapters/tau2/retained-data .container-results/fixed-stock \
  --initial-actor initial-actor.json --trials 4 --seed 300
```
