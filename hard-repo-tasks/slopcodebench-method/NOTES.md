# NOTES — checkpoint-evolution method design (SloP Code Bench)

Goal: formalize checkpoint evolution (from SloP Code Bench, arXiv:2603.24755) as
Parallax's second synthesis strategy — algorithmic model, code-quality
measurement audit, research questions, and a repeatable synthesis workflow.
Documentation and formal modeling only; no implementation.

## Work log

- Created worktree `cursor/slopcodebench-method` from origin/main (current
  branch had conflicting uncommitted work in hard-repo-tasks/).
- Read parallax/README.md, docs/MODEL.md, docs/methods/evolving-intent.md,
  .github/pull_request_template.md. Key vocabulary to reuse: TaskSpec
  τ=(g,c,x_pub,x_seal,V,R), EnvironmentSpec ε, synthesis strategy G_θ,
  perturbation δ=(δ_τ,δ_ε,δ_κ), admission predicates I_j, verifier-authority
  invariant, matched arms, estimand Δ_{a,b}, Verification vs RunFailure
  outcome split, doc conventions (timeless language, claim limits beside
  claims, GitHub alert blocks, TODO markers).
- MODEL.md already reserves a slot: "Checkpoint evolution is a separate
  strategy and state machine... Specify checkpoint-evolution states,
  transition guards, admission invariants, and controlled-arm semantics
  before implementing."

## Source findings

### Paper (arXiv:2603.24755, SlopCodeBench)

- 36 hand-authored problems, 196 checkpoints (3-8 per problem). §2.2: task is
  y_i = π_θ(x_i, y_{i-1}), y_0 empty. Fresh context per checkpoint; only the
  working directory persists (fresh Docker container per checkpoint, §3
  Setup). No conversation carry-over — the agent must recover design intent
  from the code alone.
- §2.1 design principles: (1) no prescribed internal interfaces, (2) no
  visible test suite (spec prose + embedded examples only), (3) black-box
  language-agnostic contracts (CLI/API), normalization guidance where
  arbitrary choices would cause false failures.
- §2.4 evaluation: hidden pytest suites; test categories Core (unmarked),
  Error, Functionality, Regression (= ALL prior-checkpoint tests re-run;
  C_1 has none). Verdicts: strict (all incl. regression), ISO (non-regression
  only), CORE. Crash/missing workspace ⇒ correctness 0 for remaining
  checkpoints; quality metrics excluded, not imputed. Infrastructure failure
  (pytest exit 2-5) tracked separately from test failure — maps cleanly onto
  Parallax Verification vs RunFailure.
- §2.3 quality metrics: Erosion = share of total complexity mass
  (CC × sqrt(SLOC), threshold CC>10) in high-CC callables. Verbosity =
  |ast-grep-flagged ∪ clone lines| / LOC, 137 targeted ast-grep rules.
  Both computed by a pinned `scb-check` release, deterministic, no model.
- Headline results: best strict solve 14.8% (GPT 5.5); no problem solved
  end-to-end; erosion rises in 77% of trajectories, verbosity in 75.5%;
  agents 2.0×/2.3× more eroded/verbose than 473-repo human panel, degrade
  5×/6.6× faster per checkpoint (§3.2-3.3). §3.4: anti-slop/plan-first
  prompts cut initial erosion up to 62.3%/verbosity 34.8% but do NOT change
  the degradation slope; cost +12.1%, strict −2.4 to −3.6 pp.
- Appendix B.3 sensitivity: erosion variants have ~zero predictive
  correlation with next-checkpoint pass rate (−0.018) but positive with cost
  (0.167); LOC is the strongest raw cost predictor (0.502). Important for
  claims about what these metrics measure.
- §2.2 Problem Construction: two-phase authoring. Proposal (draft + checkpoint
  partition; drop problems that don't test design decisions or that frontier
  agents one-shot), Validation (write tests, run an agent, refine ambiguous
  cases), final review for solvability + spec/test match. Each problem
  reviewed by ≥1 non-drafting author.

### Repo (SprocketLab/slop-code-bench @ 8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b)

- docs/contributing-problems/README.md: philosophy; checkpoint operators
  ("expand constraints", "narrow constraints", "modify input source",
  "change modality"); prohibitions (change core problem, add unrelated
  problems); target ~40h/~3K LOC per problem; first checkpoint defines the
  core problem and cannot be changed later; spec discipline (verbose,
  examples over prose, behavior not structure, no web-search domain
  knowledge).
- docs/contributing-problems/checklist.md: design checks incl. "can two
  correct implementations produce different outputs?" and problem layout
  (config.yaml + checkpoint_N.md + tests/ + data/).
- docs/contributing-problems/review-checklist.md: mechanical review items —
  entrypoint placeholders (%%%ENTRYPOINT%%%), error behavior as "Exit N,
  error to STDERR" without exact strings, language-agnosticity, leakage
  rules (no "Design Pressure" paragraphs, no decomposition hints),
  include_prior_tests defaults true.
- docs/evaluation/architecture.md: PytestRunner copies tests for checkpoints
  0..N, prior tests auto-become REGRESSION regardless of markers; uvx
  isolation; infra failure exit codes 2-5 set infrastructure_failure=True.
- docs/metrics-reference.md: 41 per-checkpoint metrics, delta metrics,
  composite verbosity/erosion from pinned scb-check with
  scb_check_version recorded per measurement. Also rubric.jsonl — LLM judge.
- configs/rubrics/llm_judge.jsonl: 45 criteria (25 verbosity, 20 erosion) with
  positive/negative indicators; separate channel from deterministic metrics.
- docs/KNOWN_ISSUES.md: 5/36 problems have defective *reference solutions*
  (tests asserted correct). Hand-authoring baseline is not defect-free —
  key calibration for the agent-authoring question.

### HumanLayer analyses

- benchmarking-opus-5: ran 3 problems/17 checkpoints across Opus 4.8,
  Sonnet 5, Opus 5. Opus 5 best at 4/17 strict (3 were the opening
  checkpoints of one problem). 89-98% of all lines tripped ≥1 slop rule —
  argues rules are over-aggressive. Most metrics don't separate models
  (cc_max and cloned_pct do). Skeptical of static metrics as maintainability
  oracle; argues strict-pass-under-evolving-spec is the better oracle, and
  proposes the handoff design: strong model builds C_1..C_k, weak model
  attempts C_{k+1}; weak-model success/cost measures maintainability of the
  strong model's code. Also proposes quality backpressure loops as untested
  variants.
- wsff.md: thesis — RL rewards (fail-to-pass) carry no penalty for eroding
  maintainability; maintainability has no fast oracle; prompting/harness
  can't fix a training-signal gap. Front-loaded alignment artifacts
  (product review → architecture → program design → vertical slices) are
  the human-in-loop mitigation. Relevant as an intervention *design* for CE
  arms: persistent design artifacts as declared public inputs.

### Parallax mapping decisions

- CE is a cross-episode strategy: EI perturbs the intent schedule within one
  episode and restores the source at terminal evaluation; CE never restores —
  it accumulates. The invariant dual to EI's terminal restoration is
  non-destructive evolution: no checkpoint invalidates a prior sealed test.
- Persistent state W_i = terminal workspace only (plus dependency manifest).
  Obligations Ω_i = Ω_{i-1} ∪ T_i monotone. Sealed verifier at stage i is the
  conjunction over Ω_i, executed against the external contract only.
- Static quality (scb-check) CAN be sealed: pinned version digest + rule
  digest = evaluator authority. LLM rubric CANNOT: it is a judged outcome
  (model-dependent authority), must be labeled as such. Probe-based quality
  (handoff) is natively verifiable and turns "maintainability" into an
  estimand.
- "Four-review gate" referent: the gold / no-op / mutant / tamper admission
  matrix in hard-repo-tasks/scripts/admit.py (report keys gold_reward,
  no_op_reward, mutant rejection, forbidden_path_reward). CE needs a
  sequence-level analog.

## Deliverable plan

1. algorithmic-model.md — formal model (deliverable 1)
2. quality-measurement.md — deliverable 2
3. research-questions.md — deliverable 3
4. synthesis-workflow.md — deliverable 4
5. checkpoint-evolution.md — draft method doc destined for
   parallax/docs/methods/ (deliverable 5; kept in this folder because the
   final commit includes only this folder)
6. README.md report + _summary.md

## Closing notes

- All six files written. Deliberate choices worth flagging:
  - Extended MODEL.md's single-pair G_θ output to an ordered coupled family;
    documented as the one place the abstract model needs generalizing.
  - Treated upstream `include_prior_tests: false` as a declared verifier
    intervention rather than a config knob, and upstream's zero-scoring of
    unreached checkpoints as censoring with worst-case bounds (matching the
    EI slice's missing-outcome handling).
  - The four-review-gate analog became six gates (G1-G6) because the
    sequence dimension adds two genuinely new checks: per-stage no-op
    (every checkpoint demands new work) and churn-ratio design pressure.
  - Kept the draft method doc in this folder rather than writing into
    parallax/docs/ — user instruction says don't touch parallax/, and
    AGENTS.md says the final commit includes only this folder.
- What I'd verify first if implementing: whether G4's naive-reference build
  can be made cheap enough (it doubles reference-build cost) and whether
  probe-based quality measurement is stable enough across probe seeds to
  serve as a primary outcome.

## Promotion follow-up

- The no-touching-parallax constraint was lifted after the concurrent
  parallax rewrites merged. Rebased onto origin/main (picked up #12
  RESEARCH-PROCESS.md and #14 parallax/docs/decisions/; evolving-intent.md
  unchanged) — clean, no conflicts.
- `git mv`'d the draft to parallax/docs/methods/checkpoint-evolution.md.
  Edits during promotion: dropped the "currently lives in" placement note,
  added a References pointer to this research folder, linked
  synthesis-workflow.md from Interpretation and limits, and added a [!NOTE]
  proposing (not applying) the MODEL.md extension: family-valued G_θ output
  coupled by cross-episode persistent state, and monotonically accumulating
  sealed obligations. MODEL.md itself untouched — that edit deserves its own
  review.
- Everything else (algorithmic model, quality audit, RQs, workflow) stays
  here as research trail; folder README and _summary now point at the
  promoted doc.
