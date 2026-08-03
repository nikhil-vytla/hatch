# Evolving Intent pipeline working notes

## 2026-08-02 correction

- The accepted GSM8K synthesis-kernel slice used a hand-authored proposal
  fixture. It proved deterministic compilation, sealing, admission, replay,
  and scalar grading. It did not implement Microsoft Evolving Intent's
  extraction or retrospective-expansion algorithm.
- The fixture's prompt and response digests are placeholders, and its terminal
  evolved turn repeats the complete source question. That removes the paper's
  central pressure to reconstruct active arguments from conversation history.
- The corrected definition of done is end-to-end algorithmic execution from a
  pinned benchmark record through function-and-argument extraction, argument
  counterfactual generation, chained predecessor-function generation,
  plan-first scheduling, domain rendering, and native final evaluation.
- Exact paper conversations are not required. Generated artifacts are
  stochastic. Reproduction means implementing the algorithmic stages,
  preserving their domain semantics, and testing compatibility against the
  pinned upstream implementation.
- No further generation implementation proceeds until the current codebase
  passes adversarial shortcut review and a replacement architecture is
  accepted.

## Verification predicate

A hand-authored proposal cannot satisfy the milestone. A qualifying proof must
run the generation stages through a provider abstraction, preserve raw and
parsed intermediate artifacts, schedule turns from typed intent state, avoid
restating the complete terminal task when the selected scenario requires
history reconstruction, and grade with the source benchmark's native
evaluator.

## 2026-08-02 north-star reframing

The user expanded the target from one synthesis pipeline to a research harness.
The architecture now has to support observing behavioral failures, writing
falsifiable questions, isolating interventions, constructing verifiable tasks
and environments, running controlled experiments, and accumulating evidence
for the next hypothesis. Evolving Intent and checkpoint evolution remain
concrete strategies; neither is the universal model.

### Primary-source facts

- arXiv 2607.20734 studies four questions: transfer from single-turn
  performance, effects of transition type/count/composition/order, recap
  mitigations, and interaction with source-task difficulty.
- Its main evaluation uses verified generated subsets of 200 GSM8K, 100
  BIRD-SQL, 100 BrowseComp+, and 50 SWE-bench Verified examples. The standard
  trajectory contains two reveals, two revisions, and two switches.
- The paper includes isolated transition ablations, count/composition/order
  analyses, repeated-turn controls, prompt and oracle recaps, BIRD external
  knowledge, turn-wise intent prediction, reasoning/capacity studies, and a
  preliminary Qwen3-4B GRPO result.
- Added turn count alone did not explain the paper's observed drop. That control
  does not by itself identify a belief-state mechanism.
- Final native evaluation verifies the terminal anchor. Generated intermediate
  states use generation and judge models and are not natively verified at each
  conversational turn.
- At Microsoft revision `993d6be`, extraction does not escalate; predecessor
  generation escalates at half the attempt budget; revision order is
  `[v2, ..., vN, source]`; `create_sample_swe` removes symptom-category
  arguments before the generic scheduler and re-injects those symptom arguments
  through its post-fill hook at the front of the appropriate slot or slots
  before text rendering; SWE refuses recap with dump; generated argument ranges
  use offsets 100/1000/2000.
- SloP's state recurrence is `y_i = π(x_i, y_(i-1))`: each checkpoint gives the
  next specification and prior workspace to a fresh agent context.
- SloP persists workspace files, not conversation, installed packages, shell
  history, or agent session state. Prior tests become regression obligations.
- SloP problem construction is human authored and independently reviewed. It
  is not an LLM checkpoint-synthesis pipeline in the released method.
- SloP compares just-solve, anti-slop, and plan-first prompts and reports
  correctness, cost/time, structural erosion, and verbosity. It uses one
  reported selected run per model configuration and a Python-only empirical
  track.
- WSFF program design is practitioner design evidence, not causal evidence.

### Current Parallax evidence

- `tests/test_synthesis_kernel.py` proves a deterministic GSM8K lifecycle over a
  hand-authored proposal. It does not prove Evolving Intent generation.
- `src/parallax/compiler.py` and `grading.py` prove repository compilation and
  adversarial tree grading through a path separate from the synthesis kernel.
- `architecture/episode-spine/` proves synthetic persistence, one local
  SWE-bench Lite episode, and one hosted synthetic canary. It does not prove a
  full official SWE-bench harness or the planned Verified path.
- `src/parallax/autoresearch.py` preserves useful synthetic records and paired
  summaries. It does not define an estimand, randomized assignment, uncertainty,
  or stopping rule.
- The Qwen3 8B calibration zero was accompanied by invalid submissions and no
  tracked changes. The supported result is inconclusive about the proposed
  intent mechanism and about training.
- `src/parallax/variants.py` expresses a universal symbolic algebra but is not
  connected to construction, native evaluation, or experiment execution.
- `CheckpointPlan`, `WorkspaceEpisode`, and `CheckpointSequence` are declared
  but do not implement checkpoint evolution.

### Design decisions

- Put an immutable research protocol above separate, native strategy records.
- Keep behavior, mechanism, intervention, and outcome as distinct typed claims.
- Define an RL environment by state, observation, action, transition, reward,
  termination, reset, tool/budget policy, and train/eval split. Do not infer
  training causes from benchmark evaluation.
- Require treatment/control construction, parity policy, blocking/randomization,
  replication, capability gates, negative controls, contamination checks,
  pre-registered metrics, uncertainty, and stopping/abstention rules.
- Use explicit domain catalog/constructor injection. No closed enum, automatic
  discovery, or global registry.
- Keep provider telemetry in an audit sidecar but all semantic call and
  validation evidence in artifact identity.
- Use six attempt outcomes: transport, provider, parse, schema, semantic, judge.
  Preserve parsed blobs after schema and semantic rejection.
- Structural Evolving Intent scheduler parity is primary; exact rendering
  parity is required under deterministic prefix injection. Mutable upstream
  counters do not enter production.
- `from_upstream_json` is a characterization-only import marked with the
  upstream source digest. Imported proposals cannot seal or be admitted.
- Treat live BrowseComp+ judge calls as run evidence with committed prompt,
  model, parameters, and raw request/response.
- Characterize and preserve the current baseline first. Then delete or
  quarantine unsupported production abstractions before adding replacement
  protocol or evidence records. Do not keep a multi-release dual path.

### Hypotheses, not facts

- Evolving intent may expose failures to maintain the active goal state.
- Early program-design choices may causally contribute to later structural
  erosion under iterative checkpoint pressure.
- Recap, plan-first, environment, or training interventions may improve these
  outcomes.
- A shared evidence lifecycle may make evidence reusable across future
  questions without requiring a shared transformation state machine.

Each requires a declared contrast and cannot be inferred from benchmark zeros
or observational correlations alone.

### Verification and asset gaps

- Microsoft publishes evaluation IDs but not the paper's generated Stage-3
  conversations or complete run rows.
- BIRD native evaluation needs database/evidence assets absent from the
  Microsoft repository.
- BrowseComp+ needs its licensed corpus/index, gold access, search path, and live
  judge.
- SWE-bench needs pinned records, repository revisions, images, test specs, and
  official harness; current local evidence is Lite.
- SloP execution needs a pinned problem-catalog revision and hidden tests in
  addition to the runner.
- Exact redistribution and retention permissions for those assets remain
  unresolved.

Do not invent paper fixtures. The next unit creates and executes
`.cursor/skills/verify-parallax/` against the current CLI, library, pytest, and
relevant HUD commands while collecting verification-asset receipts. It does not
add a production verification CLI. After those baseline receipts exist, the
following unit subtracts or quarantines unsupported production abstractions
before replacement records are added.

### Researcher decisions required

- Evaluation-only first generation or training support immediately.
- Scope of causal claims: behavior, prompting, environment design, or training.
- Training access, compute, cost, and seed budgets.
- Accepted evaluator stochasticity and sensitivity thresholds.
- Asset acquisition, retention, and redistribution policy.
- Released SloP problems versus new Parallax-authored problems.

### Unit 0 project-local verification baseline

- Added `.cursor/skills/verify-parallax/` with Launch, Doctor, Drive, Evidence,
  Cleanup, and Helpers instructions plus a five-entry map of current CLI and
  library behavior.
- Ran `uv run parallax build <copied experiment> --store <scratch build>` and
  `uv run parallax build --locked <copied family.lock> --store <scratch
  replay>` through the skill helper. Both returned family
  `5ebc593aee75327d17e2a9d01c2e8f86752566990c7eafeaee5c2dcb55469cf7`.
- The two seven-file artifact trees were byte-identical, all current family
  admission checks passed, and the focused CLI locked-replay test passed.
  Cleanup removed scratch state and preserved
  `.cursor/skills/verify-parallax/evidence/unit0-family-build-rerun/`.
- This receipt proves current family build and locked replay from the
  hand-authored frozen proposal only. It does not prove Microsoft Evolving
  Intent generation, upstream characterization, native asset feasibility,
  provider behavior, HUD rollout, or checkpoint execution.
- The selected Doctor checks found the console script, local package import,
  and fixture files. The documented HUD task-list command also passed from the
  `hud_env` working directory. Exact Click source availability, optional
  Verifiers execution, HUD rollout, providers, licensed assets, and official
  external harnesses remain unchecked or unavailable for this baseline.

### 2026-08-02 formal-model boundary

- Added `FORMAL-MODEL.md` as the authoritative notation for the accepted
  architecture. It labels definitions, source recurrences, executable
  invariants, estimands, and mechanism hypotheses separately.
- "Freeze" now has two precise uses: freeze the experiment and analysis before
  treatment outcomes, then freeze accepted stochastic construction before
  deterministic compilation. This is a Parallax requirement, not a claim that
  every source paper pins every field.
- The primary Evolving Intent source supports the intent-state equations,
  backward extraction and expansion, plan-first scheduler, typed delta
  rendering, final source restoration, and POMDP framing. The paper does not
  make intermediate turns natively verifiable.
- The primary SloP source supports the checkpoint recurrence, fresh context and
  container per checkpoint, workspace-only persistence, cumulative regression
  tests, native verdicts, and diagnostic erosion and verbosity formulas.
- Pinned upstream projects are characterization oracles only. Production
  Parallax owns first-principles implementations and cannot import or invoke an
  upstream runtime.
- Unit 0 proves byte-identical artifact replay for one hand-authored GSM8K
  proposal. It does not replay an agent rollout or prove source generation,
  semantic validity, upstream parity, or a causal effect.
- Release-level pinning remains open for Evolving Intent generation calls and
  provider snapshots, and for SloP's complete problem, hidden-test, image,
  dependency, and harness bundle.

### 2026-08-02 literature reconciliation

- Direct GitHub tag and commit queries resolve SCBench `v0.2` to
  `bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1`. The similar hash containing
  `...ae2ecf5...` was a transcription error and is excluded.
- Evolving Intent pins source IDs, terminal anchoring, reported transition
  counts, and code at `993d6be...`; generated conversations, results, provider
  snapshots, external assets, and a fully locked environment remain absent.
- SCBench paper v2 pins its authored checkpoint protocol, printed prompts,
  reported harness settings, and reset semantics. Runner `v0.2` still uses
  lower-bound packages and a Docker tag, while its Zenodo record stores the
  paper rather than a complete run bundle.
- Neither paper claims byte-identical replay. Parallax locked replay follows
  the narrower reproducible-build and content-addressed-artifact analogy.
- HumanLayer's program-design material and 17-checkpoint SCBench report are
  useful practitioner and observational evidence. They do not identify a
  maintainability, cost, or training effect.
- Recent work supports testing intent-aware context folding, information-gain
  RL, calibrated partial-test reward, structured planning with checkpoints,
  explicit invariant gates, and adaptive memory. Transfer and composition in
  Parallax remain hypotheses.
- Keep one app-level `verify-parallax` skill. Add independently executable
  feature helpers and receipts only for real user paths, and split a secondary
  skill only when launch or isolation semantics genuinely differ.

### 2026-08-02 provenance and selection correction

- Unit 0's valid claim is exact-byte artifact determinism. The family identity
  includes hand-authored placeholder prompt/response digests, so it does not
  prove generation provenance integrity or semantic proposal validity.
- The proposal's `school_supply_sales` context does not match the Natalia's
  clips source task. Current admission does not detect that mismatch.
- Unit 1 must delete or production-reject `parallax.frozen-proposal.v1`.
  Characterization evidence may remain readable, but placeholder-shaped strings
  cannot stand in for recorded provider provenance.
- `unit0-family-build-provenance-20260802` binds 27 exact current source inputs
  and reproduced the original family and arm IDs with byte-identical seven-file
  build/replay trees. `unit0-family-build-failure-20260802` proves an early
  command failure retains its small evidence set before scratch removal.
- The four candidate inputs and cross-judge selection are now preserved in
  [`DESIGN-SELECTION.md`](DESIGN-SELECTION.md). Candidate D is the verified
  base, with bounded grafts from B and A and the remaining asset question left
  open.
