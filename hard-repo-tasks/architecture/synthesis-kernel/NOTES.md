# Synthesis kernel working notes

## 2026-08-01

- Began Phase D from the accepted thin-kernel architecture.
- Preserving all existing Recipe, variant, campaign, SWE-bench, and exporter APIs.
- The first proof is a deterministic GSM8K family with static, matched, and
  evolved arms, frozen proposal provenance, content-addressed public and sealed
  artifacts, atomic admission, and locked replay.
- The implementation will reuse `parallax.ids` for canonical identity and will
  not call providers, deploy environments, or execute checkpoint sequences.

## Grounding and Phase D contract

- The lifecycle is immutable records in one direction:
  `SourceTask -> ProposalBundle -> SynthesisPlan -> RenderedTask ->
  AdmissionCertificate -> RuntimeSpec -> Verdict`.
- The accepted sketch maps to three deep modules. `gsm8k.py` owns source parsing
  and native answer equivalence. `evolving_intent.py` owns frozen proposal
  provenance and typed trajectory replay. `kernel.py` owns rendering, family
  admission, artifact locking, and deterministic conversation execution.
- Existing recipe compilation, grading, exports, variants, and SWE-bench APIs
  remain separate and unchanged. The kernel reuses `ids.py` and
  `grading.GradeOutcome`; it does not add another identity or outcome scheme.
- Boundary parsing is limited to checked-in JSON and TOML. Internal records are
  frozen dataclasses, plans and runtimes are closed unions, and writes happen
  only after all family admission checks pass.
- Throughput checkpoint:
  - Blocking first steps: inspect uncommitted diffs and existing identity,
    grading, CLI, and episode code before editing.
  - Independent workstreams: the domain modules, fixtures, and documentation
    are disjoint, while CLI exports and tests depend on the domain API.
  - Shared mutable state: one writer owns the tree; artifact publication uses
    temporary paths and atomic replacement.
  - Smallest safe decomposition: one implementation owner is required because
    lifecycle types, admission, serialization, and locked replay share exact
    byte-level invariants.

## Implementation evidence

- Added `gsm8k.py`, `evolving_intent.py`, and `kernel.py`; exported
  `Gsm8k`, `EvolvingIntent`, `build`, and `run` without removing existing APIs.
- Added one pinned GSM8K record, one frozen proposal, and one narrow experiment
  TOML fixture. No dataset or generated provider response was fetched.
- Added seven atomic family admission checks and exact public/sealed artifact
  rendering. Public inspection confirmed that the evolved payload contains only
  its opening turn and safe metadata; the answer and future turns appear only
  in its sealed payload.
- Found and fixed a macOS `/tmp` symlink issue in lock-relative paths. Lock
  creation now resolves both the lock parent and frozen references before
  calculating relative paths.
- Focused tests passed: 15 tests in `test_synthesis_kernel.py`.
- The complete local suite passed: 65 tests in 1.83 seconds.
- Ruff passed on the three new modules, CLI and package exports, and the focused
  test file.
- A direct CLI build and `--locked` replay produced family
  `5ebc593aee75327d17e2a9d01c2e8f86752566990c7eafeaee5c2dcb55469cf7`.
  Recursive comparison found no byte differences between the two artifact
  directories.
- The real family certificate contains all seven named checks and every check
  passed. The three task IDs are distinct while source and verifier digests are
  shared.
- Added an admission-policy revision to family identity and made the
  deterministic rebuild check compile and render a second family from the same
  frozen inputs. A fault-injection test proves admission rejects drift.
- `ConversationRun` was exercised with synchronous and asynchronous callbacks.
  `WorkspaceEpisode`, `CheckpointSequence`, and `CheckpointPlan` remain
  explicit non-executing placeholders.
- Repository-wide Ruff lint passed. The repository-wide format check found 19
  pre-existing or unrelated files that would be reformatted; Phase D files
  pass their focused format check and unrelated files were not touched.

## Cross-domain learnings

- SWE-bench and GSM8K share the artifact lifecycle but not execution or
  verification. GSM8K is a stateless conversation with scalar equivalence;
  SWE-bench needs a persistent workspace, patch capture, and its native
  harness. Runtime is therefore a closed union, not one universal episode.
- Generation is a proposal boundary. Microsoft-compatible extraction and
  scheduling may be stochastic, but accepted proposals are frozen before
  deterministic compilation, admission, execution, and reward.
- Exact paper-output reproduction is not available from the published
  Microsoft repository because it omits generated conversations and provider
  snapshots. Parallax targets algorithm and fixture compatibility plus locked
  replay of its own frozen proposals.
- Stateful precursors must be enforced as read-only. An obsolete SWE-bench
  edit can poison later turns even when the terminal intent returns to the
  source task.
- Reward-policy errors can look like model failures. The first real SWE
  calibration rejected legitimate focused tests before sealed restoration;
  allowing the test path preserved agent behavior without giving it authority
  over the official test patch.
- Aggregate reward does not establish an evolving-intent effect. The initial
  interpretation that the Django canary separated model capability was
  superseded by the raw-row audit: GPT-5.6 Sol was at ceiling, while Qwen3 8B
  made no tracked changes and received invalid-submission zeros. With one run
  per arm, this smoke test is inconclusive and supports only no observed
  matched-to-evolved difference.
- Locked GSM8K replay established the reproducibility boundary. Dataset
  acquisition stays outside synthesis, and the kernel consumes complete pinned
  records instead of resolving mutable remote IDs during a build.
- Intent and checkpoint evolution are separate strategies. Intent changes a
  latent request within a conversation; checkpoint evolution carries a
  workspace across separately verified specifications and cumulative
  regressions.
- The next architecture test is BIRD-SQL. It exercises sealed database state
  and execution-equivalence grading without introducing repository mutation.
