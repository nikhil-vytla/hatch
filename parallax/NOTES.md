# Working notes

## 2026-08-02

- Established `parallax/` as the durable product root.
- Reviewed the Evolving Intent paper and the canonical Microsoft repository at
  its immutable reference commit.
- Separated the general Parallax research model from Evolving Intent, which is
  one synthesis strategy over a task and environment specification.
- Defined the minimum vocabulary needed by implementations: task and environment
  specifications, trajectories, interventions, admission invariants,
  controlled arms, run evidence, and estimands.
- Kept verifier authority and sealed information explicit so experiments do
  not mistake evaluator drift or answer leakage for an agent effect.
- Recorded the Evolving Intent stages and semantic contracts that require
  Parallax-owned behavioral regression coverage.
- Confirmed that upstream generated pools and provider transcripts are not
  published, so this work cannot support byte-identical or paper-score
  reproduction claims.
- Removed the earlier executable evidence scaffolding and split-out research
  notes before the focused vertical slice was implemented.
- Kept the versioned documentation to the required product trio and two
  focused method documents.
- Final checks covered internal and external links, balanced display math,
  required classification labels and symbols, summary shape, private paths and
  credential patterns, and Markdown formatting.

## Implementation notes

- Named the slice before writing logic. `Problem` owns the sealed normalized
  answer. `Intent`, method-local events, `Turn`, and `Script` own construction.
  `Verification`, `RunFailure`, and `RunResult` own evaluation evidence.
- Kept ownership flat across `gsm8k.py`, `evolving_intent.py`, `runner.py`, and
  `report.py`. JSON parsers validate external rows, provider output, and JSONL
  evidence at their boundaries.
- Initially chose explicit frozen dataclasses and literal variants over a
  shared protocol core. The later Pydantic redesign below supersedes the
  dataclass choice while keeping the three arms concrete.
- Throughput checkpoint: define package and typed contracts first; implement
  disjoint modules in dependency order; isolate the only shared mutation behind
  atomic JSONL replacement; keep one implementation owner because terminal
  restoration, grading, and evidence serialization cross module boundaries.
- Implemented the offline GSM8K path with strict source and submission markers,
  typed Evolving Intent events, explicit matched controls, native grading,
  deterministic run JSONL, and deterministic paired reporting.
- Kept provider-stage construction and trajectory logic together after review
  removed the separate construction mini-framework. The provider boundary is
  synchronous and local.
- Verified 17 focused tests, Ruff lint and formatting, `py_compile`, source and
  wheel builds, isolated wheel install and import, documentation links and
  display math, timeless README and summary language, private paths, credential
  patterns, excluded architecture terms, and `git diff --check`.
- The repository-wide test command cannot collect unrelated projects in this
  worktree because their packages and Hypothesis are not installed. The
  complete Parallax suite passes from its package root.
- Mypy is not configured for Parallax and is not installed. No provider or
  network-backed experiment ran.

## Independent review revision

- Fidelity review changed the static arm from the raw GSM8K question to the
  fully revealed extracted intent rendered by the method path. No arm renders
  the source question.
- Terminal restoration remains exact state equality. The scheduler now permits
  corrections after the source-function switch, so tests cannot equate
  restoration with the position of the switch event.
- Parallax uses deterministic local scheduling as an explicit divergence.
  Upstream GSM8K construction is not seed-reproducible because predecessor
  randomness is unseeded and parallel pools use completion order.
- Statistical review replaced trial-level bootstrap inference with a
  preregistered design manifest, source-clustered identification bounds, and a
  closed-form Hoeffding interval. Recorded run failures remain scheduled rows.
- Complexity review removed the separate construction module, public helper
  constants, repeated construction evidence, duplicate atomic writers, and
  test-only schedule injection.
- Throughput checkpoint: fix shared extraction and rendering first; define the
  manifest and canonical evidence records next; aggregate only validated rows;
  keep one atomic writer; verify each boundary before the final package run.
- Rejected simplifications that would remove rejected generation attempts,
  merge verification with run failures, soften exact JSON keys, tuple-encode
  events, or delete a controlled arm. Each would weaken method or evidence
  fidelity.
- Final verification passes 25 offline tests, Ruff lint and formatting,
  `py_compile`, source and wheel builds, isolated wheel installation and import,
  documentation scans, private-path and credential scans, and
  `git diff --check`.
- Source is 1,239 lines across the five package modules. The revision applies
  the requested structural simplifications, but it does not meet the suggested
  800-line target. Strict manifest, nested row, identity-drift, missing-row,
  and source-cluster validation account for the added size. Removing those
  checks would violate the higher-priority statistical audit.

## Behavior-audit revision

- Replayed the old-tree behavior audit against the revised implementation and
  printed all current arm transcripts. The evolved arm names the predecessor
  goal on its first turn, contains no experimental-condition cue, permits
  corrections after the switch, and restores the fully revealed source intent.
- Findings 1 and 3 were fixed now. All load-bearing source assertions became
  domain exceptions, and schedule validation now rejects mismatched reveals,
  revise-before-reveal, switch-before-reveal, missing restoration, and duplicate
  switches.
- Finding 2 was partly already resolved because the public event-injection seam
  had been deleted. This revision made generated schedules pass a direct domain
  validator before rendering.
- Findings 4 and 5 were already resolved when the percentile bootstrap was
  replaced by source-clustered Hoeffding inference. This revision added a direct
  one-source `[-1, 1]` decision-gate test.
- Findings 8 and 10 were fixed in that revision. `Problem` validated authority
  at construction and `grade` defensively revalidated it. The later Pydantic
  redesign removes the second check because `SourceAnswer` now carries the
  proof.
- Findings 6, 9, 13, 14, 15, 16, 19, and 20 were fixed or strengthened now.
  Tests cover matched text purity, sorted canonical JSON keys, nested evidence
  validation, value-derived history sensitivity, validated script budgets, and
  one family-level authority with no authority in run rows. Stale capability
  prose was removed and the summary was narrowed to an implemented offline test
  path.
- Findings 7, 12, 17, and 18 were already resolved by the prior revision. The
  confounded evolved cue, trial-level bootstrap, cross-module private builder
  import, and duplicate `measured_value` field no longer exist.
- Finding 11 was rejected as stated. The static arm is intentionally one fully
  specified turn, so equal total budget implies a larger per-turn cap. The
  decision estimand compares matched with evolved, whose per-turn and total
  budgets match.
- Findings 21 and 22 were rejected as scope or declared design choices. A real
  provider adapter and CLI were explicitly outside this offline slice, and one
  changed candidate per source argument is documented as a local construction
  choice rather than an upstream parity claim.
- The audit's warning against a design manifest was superseded by the later
  statistical review, which explicitly required preregistered units, digests,
  and drift validation. The implementation keeps this narrow and local rather
  than introducing a generic artifact subsystem.
- The original mutation run reported 8 survivors among 24 mutants. The adapted
  revised-tree gauntlet has 28 active contract mutants and 3 obsolete bootstrap
  or switch-order mutants. One reveal-guard mutant survived the first adapted
  run; a mismatched-reveal regression killed it. The final adapted run killed
  all 28 active mutants.
- Final behavior-audit verification passes 40 tests in normal and optimized
  Python, Ruff lint and format checks, bytecode compilation, and source and
  wheel builds. Source is 1,283 lines and test Python is 804 lines.
  The source remains 483 lines above the suggested 800-line target because the
  higher-priority manifest, nested evidence, schedule, and statistical
  validation contracts remain explicit.

## Pydantic type-layer redesign

- The user explicitly removed compatibility and migration-churn constraints.
  The target became the clearest design we would choose if strict validated
  data had been foundational from the first slice.
- Added Pydantic 2.13.4 through `uv add pydantic`. `uv.lock` records Pydantic,
  pydantic-core, and their transitive runtime dependencies.
- `StrictModel` applies strict parsing, frozen instances, and
  `extra="forbid"` once. GSM8K rows, construction-stage replies, manifests,
  families, run rows, and every nested model now cross that boundary.
- `Problem`, `Argument`, `Intent`, `Turn`, `Script`, `ScriptFamily`,
  `GenerationAttempt`, `Verification`, `RunFailure`, `RunIdentity`, `Usage`,
  and `RunResult` are Pydantic models. They are one validated domain graph that
  can be serialized directly; retaining parallel dataclass and wire graphs
  would duplicate invariants.
- `Reveal`, `Revise`, and `Switch` form a discriminated event union.
  `Verification` and `RunFailure` form a discriminated outcome union.
  Manifest, family, and run records form a discriminated evidence union. Every
  discriminator is serialized as `kind`, and branch sites use `assert_never`.
- `SourceId`, `CanonicalInteger`, `SourceAnswer`, `DesignDigest`,
  `SourceDigest`, `ModelConfigDigest`, `ArmConfigDigest`, `ConstructionSeed`,
  `TrialSeed`, and `TrialIndex` are branded primitives. Runtime-constrained
  brands use `Annotated` constraints under `NewType`; seed brands remain
  static distinctions over strict integers.
- `Verdict` remains an enum and `Arm`, `Role`, stage names, and failure kinds
  remain literal aliases. They are closed scalar vocabularies, not records with
  independent invariants.
- No dataclasses remain. Pydantic is the clearer choice for every retained
  record because all domain values either originate at a parse boundary or
  become nested evidence. A second internal representation would add mapping
  code without removing an invalid state.
- `read_run_jsonl` now returns a typed `EvidenceRecord` union. `report.py`
  contains no `Any`, raw evidence dictionaries, exact-key tables, or nested
  structural parser. Manifest-local invariants moved into `ManifestRecord`;
  report validation is limited to relationships across scheduled records.
- `grade` no longer revalidates `Problem.answer`. `Problem` creates a validated
  `SourceAnswer`, and a regression proves grading invokes the canonical
  validator only for the model submission.
- Canonical serialization still uses `json.dumps` over
  `model_dump(mode="json")` with sorted keys, compact separators, and
  `allow_nan=False`. The representative evidence golden is 21,813 bytes with
  SHA-256
  `d5e3e23d91d8bfdfaa29e5ed968e9565c80519d65cd3335a042da99fc1787eff`.
- The adapted 28-mutant run initially left three survivors around canonical
  integer branding, non-finite threshold rejection, and empty manifests.
  Direct boundary regressions killed them. The final run killed all 28 active
  mutants.
- Final certification passes 62 tests in normal and optimized Python, Ruff
  lint and format checks, `uvx ty check src`, bytecode compilation, source and
  wheel builds, package import with Pydantic 2.13.4, and `git diff --check`.
  Optimized pytest emits only its expected warning that test assertions are
  disabled by `python -O`; source invariants use exceptions and model
  validation.
- Source is 1,519 lines across six package modules, up 236 from the reviewed
  dataclass tree. Tests are 1,088 lines, up 284. The redesign deletes the
  hand-written structural parser but adds explicit reusable schemas, branded
  constraints, discriminator contracts, and adversarial boundary tests. The
  statistical formulas and the 50-source Hoeffding golden are unchanged.

## SWE-bench Verified Slice 2

- Started `cursor/parallax-swebench-slice-2` on the final PR #11 head. The
  unchanged baseline passed 62 tests and `uvx ty check src`. After PR #11
  merged, the branch rebased cleanly onto `origin/main`.
- Read the benchmark decision from PR #13. The selected source is
  `SWE-bench/SWE-bench_Verified` at
  `91aa3ed51b709be6457e12d00300a6a596d4c6a3`. The admissible source set is the
  50 IDs published by Evolving Intent at
  `993d6be9597ac03854b46362ccd647eb1bfd267a`; ten cross-repository IDs are named
  as the initial screening pool.
- Chose direct OpenAI-compatible HTTP over LiteLLM. Construction needs a
  synchronous text call, while the agent boundary needs the same request and
  response records plus tool calls. Strict frozen wire models cover both
  without adding provider routing or SDK dependencies. The API key remains in
  a named environment variable and never enters request evidence.
- `SweBenchProblem` owns public issue metadata. `SweBenchVerifier` owns the
  sealed gold patch, test patch, FAIL_TO_PASS and PASS_TO_PASS tests, harness
  revision, and official image identity. The gold patch is absent from public
  task models, prompts, agent artifacts, and run rows. Admission G4 reads it
  only through sealed authority.
- The loader checks the pinned Hugging Face revision before and after reading
  rows, rejects partial responses and IDs outside the published 50, and
  requires an image digest and test command for every selected source. Tests
  use scripted transports only.
- The SWE construction boundary returns categorized source and predecessor
  intents. The scheduler records symptom removal and reinserts symptom
  arguments first in their owning phase before text rendering, matching the
  characterized overlay. It deliberately schedules whole function phases
  rather than claiming upstream prompt or slot parity. The terminal evolved
  state equals the exact source intent.
- Static receives the public issue once. Matched remains at the source intent
  for the evolved turn count. Evolved traverses predecessor phases and restores
  the source. All three arms share the exact problem and verifier and receive
  one equal total agent-step and output-token budget. This fixes the calibration
  confound where static previously received 12 steps total while multi-turn
  arms received 12 per turn.
- Environment rendering produces canonical `instance.json`, a generic HUD
  `env.py`, and `Dockerfile.hud`. The Dockerfile uses an official
  `swebench/sweb.eval` image by digest and contains no clone or fetch. The
  grader removes test edits from the submitted patch, restores and applies the
  sealed test patch, and runs the preregistered command. The per-instance path
  allowlist was removed; changed paths remain an audit metric.
- Screening uses a strict manifest, source and verifier digests, trial seeds,
  canonical JSONL outcomes, and the existing Verification/RunFailure split.
  Executor exceptions remain operational failures. The harness refuses every
  unapproved run and hard-stops any plan with an upper estimate above $20.
- The recommended first gate is five published instances, two static trials,
  and one boundary model. At the plan's calibrated $0.10-$0.50 per episode,
  ten episodes cost an estimated $1-$5. The ten-instance version costs $2-$10.
  The 135-episode pilot remains $13.50-$67.50 and is explicitly outside the
  screening approval.
- No provider call, image pull, environment build, HUD deployment, or paid
  episode ran. A read-only live metadata probe loaded
  `astropy__astropy-13236` through the pinned Hugging Face boundary and found
  2 FAIL_TO_PASS plus 644 PASS_TO_PASS tests.
- Final certification passes 88 tests in normal and optimized Python,
  `ruff check src tests`, `ruff format --check src tests`,
  `uvx ty check src`, bytecode compilation, source and wheel builds, package
  import with Pydantic 2.13.4, and `git diff --check`.
  Source is 2,942 lines across ten modules, up 1,423 from Slice 1. Tests are
  1,677 lines, up 589.
- The unchanged Slice 1 mutation gauntlet still kills all 28 contract mutants.
  The Slice 2 gauntlet kills all 17 active boundary mutants, covering provider
  strictness, source pins, sealed-prompt exclusion, overlay ordering,
  restoration, equal budgets, official image selection, and spend controls.

## Screening safety audit

- An adversarial review correctly found that the rendered single-container HUD
  bundle is not sealed: `/app/instance.json` contains the test patch, test IDs,
  and command and is readable by an agent with shell access.
- Its embedded grader is not the official SWE-bench verifier. It checks only
  process exit zero, does not parse named FAIL_TO_PASS/PASS_TO_PASS statuses,
  misses untracked candidate files, and mishandles tests added by the patch.
  The earlier environment claims above describe intended behavior, not an
  admitted measurement path.
- Paid screening was stopped before any request. Secure evaluator isolation,
  official harness grading, and digests binding scripts/environment/provider
  settings remain blockers.
- The no-spend branch adds an eager HUD credential adapter, revision-bound
  dataset rows, typed verifier failures, a $5 default cap, manifest-first
  execution, per-unit atomic receipts, resumability, and usage/cost fields.
- A scripted transport dry run made zero network and paid calls. Certification
  passes 102 tests normally and under `python -O`, Ruff, `ty`, build, the
  28-case core mutation suite, and the 30-case adapted Slice 2 audit suite.
- Consolidated review fixes keep request models closed while allowing
  unconsumed real-provider response fields, classify output truncation as a
  budget fault, bind dataset rows to the requested revision, validate published
  IDs before query construction, and reject truncated cells.
- Screening evidence now uses an exclusive partial file with append-and-fsync
  per unit, resume identity checks, no final-file overwrite, recorded provider
  model/usage/cost, and cumulative observed-cost checks.
- Report validation closes the retained-script arm-digest chain. The unsafe
  embedded-verifier renderer fails closed unless explicitly enabled for offline
  inspection.

## Screening boundary revision

- Investigated HUD v6 before selecting an isolation design. Its native
  `Workspace` serves agent shell operations through a `bubblewrap` namespace;
  the SDK's coding-agent pattern keeps authoritative checks outside that
  workspace. SDK 0.6.12 does not mount `/app` by default and supports a
  fail-closed UID drop.
- Replaced the unsafe embedded grader rather than extending it. The HUD image
  now contains public config only, requires/probes the namespace and UID wall,
  and exports a candidate patch. The evaluator alone holds the sealed dataset
  row and runs `swebench.harness.run_evaluation` at the pinned revision against
  the digest-pinned official image.
- Deleted the custom restore path and `test_command` authority. A temporary Git
  index plus `git add -A` captures modified, deleted, and untracked files. The
  official harness report is authoritative, with exact test-set coverage as a
  cross-check.
- Moved the environment implementation from an embedded source string to
  importable `swebench_runtime.py`; generated `env.py` imports it. Extracted
  `canonical.py` and `outcome.py` leaves so canonical evidence and outcome
  unions no longer belong to the GSM8K runner.
- Screening persists the manifest before execution, each completed unit with
  fsync, and each paid HUD episode before official grading. Receipts include
  provider-reported model, usage, conservative cost, official report digest,
  harness revision, and image digest.
- Reports expose minimum-detectable-effect and power. Designs above the
  declared MDE tolerance remain inconclusive/underpowered instead of emitting
  advance or reject.
- Added the pinned HUD runtime dependency and reproducible test/lint
  development dependencies. HUD is isolated in `/opt/hud-venv` in generated
  images; its transitive wheels are still resolved at image-build time, a
  residual agent-runtime reproducibility limitation that cannot alter the
  separate official grader.
- Offline certification reached 106 tests. The adapted mutation suite killed
  34/34 mutants, including official coverage, untracked patch export,
  public-only environments, and small-n power gates.
- Resolved immutable Docker Hub manifests for five preregistered instances.
  HUD model discovery authenticated, but the first Claude Haiku 4.5
  construction request returned HTTP 403 before any response. The stop rule
  terminated screening at zero recorded tokens and $0 estimated spend.

## Checkpoint-evolution slice

- Implemented the second synthesis strategy as an offline vertical slice:
  `checkpoint_evolution.py` (workspace/checkpoint/sealed-case domain model,
  entrypoint-only subprocess verifier with strict/isolated/core verdicts,
  five executable admission gates) and `checkpoint_runner.py`
  (harness-owned checkpoint delivery, `evolved` and `carry-reference`
  arms, digest-chained stage receipts, preregistered manifest, canonical
  evidence JSONL). Design inputs: `research/slopcodebench-method/` and
  `docs/methods/checkpoint-evolution.md`, now updated to as-implemented.
- Obligations accumulate monotonically (Ω_i = Ω_{i-1} ∪ T_i) with
  automatic regression reclassification; strict grading gates stage N on
  stages 1..N-1 still passing. `include_prior_tests: false` is not
  representable.
- Delivery is unskippable by construction: agents are pure functions of
  (public spec, carried workspace, budget); `FamilyRun` validators reject
  skipped, reordered, or spec-drifted delivery, broken workspace-digest
  chains, and censoring that is not exactly the undelivered suffix.
  Unadmitted families are unrepresentable to the runner.
- Seed family `ce-tally-1` (3 checkpoints, 10 sealed cases, hand-verified
  incremental references) admits under all five gates; vacuous, broken,
  misaligned, and leaky variants reject with recorded per-gate detail.
- Declared interpretations: Python-track entrypoint pin, per-case fresh
  materialization, oversized-return-as-budget-RunFailure, empty
  dependency manifest, single reference build. Deferred: quality
  measurement (all classes), `monolithic`/`foresight`/`repair-scheduled`
  arms, synthesis pipeline S1–S6 with gates G3/G4/G6, CE report module,
  real-agent sandboxing.
- Certification: 153 tests in normal and optimized Python, Ruff lint and
  format, `uvx ty check src`, `compileall`, source and wheel builds, and
  a 14-mutant behavioral gauntlet fully killed (checkpoint-skip,
  obligation-drop, role-mislabel, gate-inversion, chain-break, censoring,
  digest-binding). No provider call or paid episode ran.

## Checkpoint-evolution screening prerequisites

- Implemented both preregistration blockers without touching the frozen
  harness semantics: `checkpoint_agent.py` (provider adapter:
  spec+workspace rendered to the existing HUD-gateway boundary, strict
  JSON file-map parse with exact-fence tolerance, per-stage token/cost
  metering into `StageReceipt.usage` even on post-spend failures,
  truncation → budget RunFailure, model-drift/unmeterable replies →
  agent RunFailures) and `checkpoint_sandbox.py` (every sealed case in a
  disposable digest-pinned `python@sha256:57cd7c…` container,
  `linux/amd64`, no network, read-only rootfs except the working
  directory, non-root user, CPU/memory/pid limits, in-container case
  timeout stays a case failure, docker faults are verifier RunFailures).
- `checkpoint_screening.py` drives the preregistered design in two
  modes: an offline dry run (scripted gateway transport, no key, no
  spend — evidence committed for the full 10-seed shape and for a
  sandbox-routed variant) and the live run (spend approval + $5 hard
  cap enforced before and during, mandatory sandbox with no host
  fallback, execution identity bound into the evidence digests).
- Certification: 197 tests in normal and optimized Python (including
  real-container integration probes for network/rootfs containment),
  Ruff, ty, compileall, builds, and the gauntlet extended to 24 mutants
  (sandbox-bypass, isolation-drop, timeout-reclassify, metering-drop,
  fence-unwrap-drop, approval-drop all killed). Still no paid call: the
  screening awaits user approval and a rotated HUD key.

## Power gate removed

- An adversarial audit found the `powered`/`action` gate unreachable at every
  scale this harness can run, reversing the decision recorded under "Screening
  boundary revision". Screening's half-width is `sqrt(ln 40 / 2n)`, so the 0.2
  tolerance needs 47 source clusters and rounds ran 5 to 6. The report's
  half-width is `sqrt(2 ln 40 / n)`, needing 185 clusters against a published
  admissible pool of 50. `advance` and `reject` were therefore dead states, the
  preregistered `threshold` never influenced an output, and every run was
  condemned to `inconclusive`/`underpowered` by arithmetic rather than by
  evidence.
- Deleted `ManifestRecord.threshold` and its validator, the `Threshold` type,
  the `threshold` parameter on `run_experiment`, `MAXIMUM_DECISION_MDE`,
  `MAXIMUM_SCREENING_MDE`, `ScreeningSummary.powered`, `ScreeningSummary.action`,
  and the `powered`/`threshold`/`action` keys on the report. Kept the paired
  point estimate, identification bounds, confidence interval, and
  minimum-detectable-effect as reported facts.
- Dropping `threshold` from the manifest body changes the design digest, so
  the byte-stability golden hash moved. Committed evidence and report JSON
  under `research/` are historical records and were left untouched; nothing
  reads a `ScreeningSummary` or a manifest back from those files.
- Merging the pipelines doc and the single-vs-evolved experiment found two more
  copies. `docs/PIPELINES.md` passed `threshold=0.1` to `run_experiment` and
  printed `report["action"]`; the snippet now prints the interval instead and
  its pasted output was regenerated by running it. `analyze_experiment.py`
  carried its own `MAXIMUM_DECISION_MDE` and `powered` flag, now deleted; its
  committed `experiment-report.json` keeps the old `powered` key, so the script
  no longer reproduces that file byte-for-byte. `admission.py`, `delivery.py`,
  and the checkpoint-evolution modules are clean — the `advance_trigger` names
  in delivery describe turn scheduling, not a statistical decision.
## Consolidation pass, 2026-08-04

Subtractions. `conformance.py` and its test went: no caller outside that test,
and the test only compared two fakes it defined itself. `INITIAL_SCREENING_IDS`
had one consumer, a test asserting its length. `build_swe_script_family`'s
`seed` was recorded into `SweScriptFamily` and `PublicTaskV1` but could not
change a deterministic construction, so it was a false reproducibility claim in
the task spec rather than a missing feature. `PositiveInt` was defined four
times and `StrictModel`/`NonEmptyText` twice; they live in `types.py` now.

Four of the six admission gates could not fail. `arm_completeness` was the
literal `True`. `schema` round-tripped Pydantic through its own serializer.
`budget_match` re-checked equal arm budgets (already a `SweScriptFamily`
validator), agreement with the environment (already `compile_hud`), and equal
matched/evolved per-turn steps (`_allocate_steps` is a pure function of total
and turn count). `sealed_leakage` called `find_sealed_leak` on a bundle
`compile_hud` had just refused to return unless that same call found nothing.
The committed receipts show it: those four rows recorded hardcoded passes and
echoes of their inputs, while `noop` and `gold` carry harness revisions, report
digests and test counts. `AdmittedSweFamily`'s validator recompiled the whole
HUD bundle on every construction; the digest binding it enforced is real, so it
moved to `assert_admission_identity`, called once per family from
`build_admitted_screening_plan`, where spending is authorized.

Encodings, strongest rung available for each:

- `metering.py` is the only place a dollar figure is produced. Rates key on the
  exact model identifier, and an unlisted model raises rather than being priced
  at zero. `tests/test_metering.py` fails once `PRICING_AS_OF` is more than 90
  days old, so staleness is a test failure and not a silent misprice.
- `hud_wire.py` is the only boundary where a HUD or provider payload becomes a
  domain model, tolerant on input and strict on consumption, with recorded
  fixtures under `tests/fixtures/wire/` replaying each quirk offline for $0.
- Per-unit paths in `HudExecutor` carry the whole unit identity, so the
  cross-arm cache collision a driver worked around with one executor per arm is
  now unrepresentable.
- `preflight.py` holds the operational lore as code: `require_docker()` runs
  inside `_docker_build`, so no image build can skip the platform pin, daemon
  probe or disk headroom check; `sleepless()` and `terminate_group()` are the
  supported ways to hold a long run open and to stop one.
- `single_writer()` takes an exclusive flock for the whole of `run_screening`,
  so a second session writing the same evidence file is refused by the kernel
  rather than by a human reading a process list.
- `paired.py` holds the source-clustered paired-bounds math that a driver had
  reimplemented line-for-line. It decides nothing: no threshold, no action, no
  power verdict.
- `tests/test_mutation_gauntlet.py` is a committed gauntlet, 19 mutants over
  delivery, admission, metering, the wire boundary, the arm cache key, the
  evidence lock, preflight and paired bounds. Run it with `pytest -m mutation`.

Two findings from doing the work:

- `screening.jsonl` from the first round-two screen carries receipts priced at
  retired Opus rates, 15/75 per million against the current 5/25, overstating
  that component 3x. `summarize_round2.py` had always re-derived cost from
  recorded token counts rather than summing the receipts, which is why its
  report was right; it now re-derives through the canonical table, and the
  comment says why summing the receipts would be wrong.
- The drifted operating-point copy in `summarize_round2.py` (`== 0`/`== 1`
  against the package's `<= 0.1`/`>= 0.9`) did not mis-select anything. The two
  rules agree for every pass rate reachable in nine or fewer verified trials
  and first disagree at ten, and round two used three. It was a latent
  divergence, which is why it survived; `test_screening.py` now pins the
  boundary. Re-running `summarize_round2.py`, `analyze_experiment.py` and
  `preregister_experiment.py` after the hoist reproduces their committed
  reports byte-for-byte.

Consequence worth recording: removing `construction_seed` changed
`PublicTaskV1`, so the committed admission receipts' spec and bundle digests no
longer describe current specs. Re-running the single-vs-evolved experiment needs
re-admission first. The receipts keep their recorded `noop` and `gold` rows
verbatim.

Merged the checkpoint-evolution slice (#27) mid-pass. It had landed its own
copies of two consolidated fixes: an exact-prefix/suffix JSON fence unwrap in
`checkpoint_agent.py`, and `HAIKU_STAGE_PRICING` restating the Haiku rate as
literals. Both now go through `strip_json_fence` and `pricing_for`. Its
budget-based `StagePricing` estimator keeps its own shape, because it prices a
worst case from a token budget rather than metering spend that happened; only
its rates come from the canonical table. Two gauntlet mutants cover both.
Follow-ups after PR #30 merged, 2026-08-03 late:

- `report.py` now calls `paired.py`. The decision gate that had entangled that
  block with report-local state is gone, so the last copy of the paired math
  went with it: 41 lines out, 18 in, and regenerating the flagship experiment
  report reproduces every field bit-for-bit except the `powered` flag that #30
  deleted. `paired_bounds` takes a `TypeVar` bound to `str` for its source key,
  because `Mapping` is invariant in its key and `report.py` keys by `SourceId`.
- Audited what the paid runs actually cost, in `research/spend-audit-20260803/`.
  The short version: round 1 is overstated on record ($1.669650 written,
  $0.518250 true), round 2's widely quoted $2.972512 is correct and
  token-derived, the single-vs-evolved $1.219080 is correct but its unmetered
  band was retired-rate-derived ($0.31-0.52, not $0.40-0.80), and the
  checkpoint slice's $0.281291 is correct. Total: $4.991133 metered,
  $5.30-$5.53 all-in.
- Two things made this worth encoding as a script rather than a paragraph.
  Receipts cannot be summed, because several were written at retired rates and
  because a resume replays cached episodes into a new file, so a naive sum over
  all evidence gives $14.381233 against a true $4.991133. `audit_spend.py`
  therefore re-meters from retained tokens only, and asserts each replay
  relation instead of assuming it: if a supposed replay's token counts moved, it
  re-paid, and the audit fails rather than merging the rows.
- Zero-token rows needed reading one by one. Round 1's preflight failures and
  round 2's leak-scan and Docker-disk failures aborted before inference and cost
  nothing. The single-vs-evolved run-1 rows recorded zero on episodes that had
  already run and been billed, because the pre-fix failure path raised before
  capturing usage. Only that one is an unmetered gap.
- The gauntlet gained two mutants over the audit itself (trust the recorded
  dollars; count replayed episodes again) and now copies `research/` into its
  sandbox. It had been excluding it, which meant every evidence-replay test
  failed for a missing file inside the sandbox and read as a kill regardless of
  what the mutation did. 21 mutants, all killed.
