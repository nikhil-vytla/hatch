# Notes: admission QC gate specs and review skill

Working notes, chronological. The report is in [README.md](README.md).

## Scope and constraints

Approved unit from the upstream design audit
([PR #21](https://github.com/nikhil-vytla/hatch/pull/21), branch
`research/upstream-design-audit`): build the admission QC layer's
research-and-skill half. Another agent is rewriting `parallax/src` on the
PR #20 branch (`cursor/parallax-screening-run`), so this unit does **not**
touch `parallax/src`. Deliverables: distilled best practices with citations,
precise gate specifications for the in-code half (referencing PR #20 branch
module/type names so the implementer can build without redesign), and a
project skill for the judgment-side review.

User constraints on the skill:

- Not overly prescriptive. Judgment prompts and best practices, not rigid
  checklists that force busywork.
- Incorporate best practices from open-source docs on building high-quality
  RL tasks; cite what was actually used.

## What I read (internal)

- `parallax/research/upstream-design-audit/README.md` on branch
  `research/upstream-design-audit` (commit `a1fbe6b`). Q2 is the direct
  parent of this work: the QC survey table, the "if a check can be wrong in
  a way a regression test would catch, it is code; if it can only be wrong
  in a way a reviewer argues about, it is a skill" dividing line, and the
  recommended gate list (schema, sealed-leakage, no-op, gold with
  flaky-retry, budget matching, simulation viability).
- PR #20 branch (`cursor/parallax-screening-run`), read read-only from the
  live worktree at `/Users/nikhil/work/hatch-parallax-ei` (base commit
  `5984ce4` plus the other agent's in-flight changes). Files that matter for
  gate placement:
  - `types.py`: `StrictModel` (strict/frozen/extra-forbid), digest newtypes.
  - `swebench.py`: `SweBenchProblem`, `SweBenchVerifier` (sealed:
    `test_patch`, `fail_to_pass`, `pass_to_pass`), `SweScript` (has an
    inline sealed-material check in `aligned_budget`), `SweScriptFamily`
    (arm/budget invariants in `controlled_family`),
    `build_swe_script_family`. **Observation:** `_DatasetRow.patch` (the
    gold patch) is parsed but dropped: `SweBenchProblem` never carries it.
    The gold gate needs it; flagged in the spec.
  - `specs.py` (new on branch): `TaskSpecV1` = `PublicTaskV1` +
    `SealedAuthorityV1`, `EnvSpecV1`, `freeze_swe_specs`.
  - `hud_compile.py` (new): `CompiledBundleV1`, `sealed_fragments`,
    `assert_agent_artifacts_clean`, `SealedLeakError`. This is already a
    sealed-leakage lint over compiled agent artifacts, including hunk-line
    and test-name fragments.
  - `conformance.py` (new): `run_conformance` with fixed submissions
    `known_good` / `known_bad` / `sealed_test_touch` / `harness_crash`;
    checks reference grader vs compiled grader agreement. Adjacent to, but
    not the same as, the no-op/gold admission pair: conformance checks the
    *compiled grader agrees with the reference grader*; admission checks the
    *task itself* is well-posed (gold passes, no-op fails).
  - `swebench_harness.py`: `run_official_harness` → `HarnessEvaluation`.
    **Observation:** with an empty `model_patch`, the official harness
    reports `patch_exists=False` and short-circuits to WRONG *without
    executing tests*. A naive "empty patch must fail" no-op check would
    pass vacuously. The no-op gate spec requires an identity patch that
    applies cleanly so the F2P tests actually run and are observed failing.
  - `screening.py`: `ScreeningPlan` / `build_screening_plan` /
    `run_screening`; the scheduling side. Sources enter as
    `ScreeningSource(source_id, source_digest, verifier_digest)`. Admission
    must complete before `build_screening_plan` freezes the design digest.
  - `outcome.py`: `Verification` / `Verdict` / `RunFailure` /
    `FailureKind`; gates reuse these as evidence vocabulary.
  - `gsm8k.py`: `grade`, `parse_final_answer`; GSM8K oracles for the
    domain-generic gate predicates.
  - `canonical.py`: `canonical_digest`, `atomic_write`; evidence recording.
- `parallax/docs/MODEL.md`: the formal admission definition
  ($I_j(\tau',\varepsilon')\in\{0,1\}$) and its typical-checks list;
  gates are implementations of these predicates.
- `parallax/.cursor/skills/distill-research-learnings/`: skill conventions:
  frontmatter with trigger-rich description, numbered workflow, destination
  table, a mechanical validator for the mechanical rules only.

## What I read (external), and what each contributed

Fetched 2026-08-02. Full source table with URLs in README.md.

1. **slop-code-bench contributing-problems checklists**
   (`docs/contributing-problems/checklist.md` and `review-checklist.md`,
   repo SprocketLab/slop-code-bench, main). The two published human-review
   checklists the audit identified as the model for the judgment side.
   Key extractions: "Could two correct implementations produce different
   outputs?" as the operational ambiguity test; leakage as *what-not-how*
   (no algorithm names, no design-pressure paragraphs, no prescribed
   decomposition); error specs deliberately under-specified ("Exit N, error
   to STDERR", never exact strings, to avoid false ambiguity; "Would a
   human SWE need to ask clarifying questions?" as a naturalness probe.
   Also a caution: their checklists are long and mechanical in places,
   which is exactly what the user asked the skill not to become. Used them for the
   *questions*, not the format.
2. **METR Task Development Guide** (taskdev.metr.org, the Desiderata and
   Quality Assurance pages). The QA page is the strongest statement of
   reviewer independence: the QA runner must not be the author and must see
   only what the agent sees. The "pre-validated tasks" alternative maps
   exactly to our gold/no-op gates: "try submitting an invalid solution, a
   partially-correct solution, and the best solution you have; confirm for
   each that the score is what you expect." Desiderata: tasks shouldn't be
   difficult for incidental reasons; not "weird or confusing in a way that
   might unfairly throw the agent off"; competent agent >0.9, incompetent
   <0.1; scoring tolerant of format noise; cheating prevented by technical
   measures, not review.
3. **HUD "Designing tasks"** (docs.hud.ai/v6/reference/advice). The best
   single page on judgment review of RL tasks. Cheapest-path principle
   ("the highest reward an agent can get without doing the work the task is
   about must sit at or below the floor"); the four-way leakage taxonomy
   (root-cause, grader, eval-context, author artifacts), where mechanical
   lints catch verbatim bytes and judgment catches paraphrase and hint; prompt-grader
   alignment and score-quality monotonicity; difficulty is relative to a
   named model; same-shape taskset diagnostic ("if you can summarize every
   task with one sentence varying only the nouns").
4. **Prime Intellect verifiers v1 GUIDE + Environments Hub docs**
   (github.com/PrimeIntellect-ai/verifiers `verifiers/v1/GUIDE.md`;
   docs.primeintellect.ai). `uv run validate` is a shipped, model-free gold
   check ("the gold patch makes the tests pass, the verifier accepts the
   gold answer"), run per-task in the task's runtime, with per-task
   isolation: "a raised error is data, not a crash," captured as
   `valid`/`invalid`/`timeout`/`error`. The audit's Q2 survey also
   documents the Hub's no-op validation and 10-retry flaky/broken
   separation on verified re-uploads. This is the direct precedent for our
   G3/G4 pair and the flaky-retry policy.
5. **SWE-smith docs + paper** (swesmith.com/guides/harnesses;
   NeurIPS 2025 paper). Validation harness: run suite pre-patch, apply
   candidate, rerun; keep only candidates breaking ≥1 previously-passing
   test; 2-minute runtime discard. The report.json per candidate
   (FAIL_TO_PASS/PASS_TO_PASS + full test output) is the evidence-recording
   precedent. The paper's admission that LLM-generated issue text is *not*
   validated ("no checks for under-specification or solution leakage") is
   the cautionary tale the skill's rendered-turn review exists to avoid.
6. **Anthropic, "Demystifying evals for AI agents"**
   (anthropic.com/engineering/demystifying-evals-for-ai-agents). Grader
   taxonomy (deterministic where possible, LLM where necessary, human for
   calibration); "unambiguous success criteria that two domain experts
   would grade identically"; 0% pass@100 usually points to a broken task,
   not an incapable agent (the gate-triage prior); "read the transcripts"
   as the non-negotiable practice, because metrics say something changed
   and only transcripts say why.
7. **METR Task Standard repo** (github.com/METR/task-standard). Automated
   pytest pattern: tests run *inside the task environment* and assert the
   score of a known-good and a known-incorrect solution. Same
   bidirectional idea as gold/no-op, phrased as regression tests.

Not used: OpenAI has no current standalone eval-authoring guide comparable
to Anthropic's engineering post (their evals docs are product/API docs for
the Evals platform); SWE-Gym's writeup adds only the "gold patch must pass
more tests than base" filter plus ~200 hours of manual dependency work,
already summarized in the audit table, so it is cited via the audit rather
than re-derived.

## Design decisions

- **Six gates, not five.** The task named schema, sealed-leakage, no-op,
  gold, budget-matching. The audit's Q2 also recommended simulation
  viability (the evolving-intent 23-config lesson: admit only sources that
  support every arm, or you silently change the population between
  conditions). On the PR #20 branch this is real: `build_swe_script_family`
  raises `SweBenchError` mid-population. Included as G6 (arm-completeness),
  since dropping it would rebuild the population-drift confound the audit
  called out.
- **Gate evidence must not re-leak sealed bytes.** G2's failure evidence
  records the artifact path and a digest/prefix-length of the matched
  fragment, never the fragment itself. Otherwise the admission record
  becomes a new leakage surface for anything that reads evidence into an
  agent context.
- **No-op needs an identity patch, not an empty patch.** See
  `swebench_harness.py` observation above. Without this the no-op gate is
  vacuous on SWE-bench.
- **Gold patch is currently dropped at ingestion.** `_DatasetRow.patch`
  never reaches `SweBenchProblem`. G4 requires carrying it as sealed
  material (spec proposes `SweBenchVerifier.gold_patch` /
  `SealedAuthorityV1.gold_patch`). Flagged as the one schema change the
  implementer must make; everything else composes existing types.
- **Retry policy: retries are for run failures, never for verdicts.** A
  WRONG verdict on gold is deterministic evidence of a broken task;
  retrying it shops for flakiness. Only `RunFailure` (infra) outcomes
  retry, bounded (3), and a pass-after-failure admits with
  `admitted_flaky` recorded. This is Prime Intellect's flaky/broken separation
  with a smaller budget (they use up to 10; our per-run cost is a full
  container evaluation, and anything needing >3 infra retries is a broken
  environment by our own standards).
- **Conformance ≠ admission.** `run_conformance` (branch) checks the
  compiled grader agrees with the reference grader. G3/G4 check the task
  itself is well-posed. Both use the same submission machinery; the spec
  keeps them separate records so a conformance failure (compiler bug) is
  not misfiled as a task rejection.
- **Skill: five questions, no checklist.** Per the user constraint. The
  slop-code-bench checklists were mined for questions but their
  50-checkbox format was deliberately not copied. Validator kept minimal
  and mechanical-only (identity fields, a decision line, an evidence
  pointer, length bound) matching the distill-research-learnings pattern of
  "the validator encodes the mechanical rules". It validates the verdict
  *record*, never the judgment.
- **Verdict records live in the research trail** (`parallax/research/`
  per-family folders), not in `docs/`, since they are point-in-time
  judgments about specific generated families, not durable contracts.

## Dead ends / corrections

- First draft of G3 used `run_official_harness` with `model_patch=""`.
  Caught that `patch_exists=False` short-circuits before test execution
  (`swebench_harness.py` lines 224-226 on the branch). Rewrote to the
  identity-patch requirement with `fail_to_pass_success == ()` as the
  observable.
- Considered making the LLM-judge checks (counterfactual minimality etc.)
  a seventh gate. Rejected: the audit and `checkpoint-evolution.md` both
  hold that rubric judgments are excluded from admission; they stay
  below-the-bar evidence, and the skill's triage question covers reading
  them.
- Considered putting the five judgment questions into the gate layer as a
  mandatory sign-off field. Rejected as exactly the busywork the user
  vetoed; the skill states when review is worth invoking instead.
