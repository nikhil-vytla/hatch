# Repeatable checkpoint-family synthesis workflow

SCBench's problems are hand-authored: "All of our problems are written by
hand, either as novel tasks or inspired by popular repositories" (paper
§2.2). This document designs a workflow that targets comparable quality
without pure hand-authoring, and specifies the admission gates that keep
generated families honest.

## 1. What hand-authoring actually consists of upstream

Decomposed from paper §2.2 (Problem Construction) and the repo's
`docs/contributing-problems/` (README, `example_process.md`, `checklist.md`,
`review-checklist.md`):

1. **Seed selection.** "Take a tool/app/repo you know well and turn it into a
   problem. Add twists during checkpoints to prevent exact 1:1
   implementations." Alternative seed: things agents failed at. Constraint:
   no frontend; target ~40 h / ~3K LOC per problem.
2. **Final-state-first planning.** `example_process.md` starts from "What
   does the *final* program do?", writes explicit good/bad solution shapes,
   then partitions into checkpoints (first checkpoint = the core problem,
   immutable; later ones single-focus, non-destructive).
3. **Spec drafting** under a strict discipline: verbose, examples over prose,
   behavior not structure, all normalization pinned, no future-checkpoint
   leakage, no web-search-dependent domain knowledge.
4. **Proposal review.** Drop problems that "did not meaningfully test design
   decisions, or that frontier agents could solve in a single shot." Every
   problem reviewed by at least one non-drafting author.
5. **Validation.** Write the sealed suite, run an agent against each
   checkpoint, use the runs to find ambiguous or under-specified tests; final
   pass confirms solvability and spec/test match.

Two facts calibrate the bar. First, most of these steps are *procedural* —
the repo documents them as checklists precisely because they are meant to be
executed mechanically. Second, hand-authoring did not reach zero defects:
`docs/KNOWN_ISSUES.md` records defective reference solutions on 5 of 36
problems at release (tests asserted correct). The realistic target for
agent-assisted authoring is "at or below the hand-authored defect rate under
the same gates," not perfection.

## 2. Pipeline

```
SCOUT ──▶ PLAN ──▶ DRAFT ──▶ BUILD ──▶ ADMIT ──▶ CALIBRATE ──▶ FREEZE
 (agent)   (agent)  (agent)   (agent)   (gates     (live agent    (human
                                         G1–G6)      runs)         sign-off)
```

Every stage emits a typed artifact with a content digest; the frozen family
records the full provenance chain (seed, plan, spec digests, suite digests,
gate receipts, calibration evidence) — same discipline as the Evolving
Intent slice's preregistered manifests.

### Stage S1 — Scout: checkpoint-decomposability assessment

Input: a candidate seed (repository, CLI tool, API service, or an existing
benchmark task family — e.g. a SWE-bench Verified repository's feature
surface). Output: a **decomposability brief** that scores the seed on:

- **Contract stability**: is there a natural external contract (CLI/API)
  whose core survives 3–8 evolutions? (First checkpoint is immutable.)
- **Axes of variation**: ≥ 2 orthogonal axes (formats × operations ×
  interfaces × constraints) so later checkpoints can extend without changing
  the core problem.
- **Determinism**: can outputs be normalized to a single correct byte
  stream? (Random simulation allowed only under the many-trials framing,
  `checklist.md`.)
- **Domain closure**: solvable without web search once the spec includes the
  needed equations/rules.
- **Design-pressure potential**: at least one plausible myopic architecture
  that later checkpoints punish (the brief must *name* the naive and
  anticipatory architectures, as `example_process.md` does with its good/bad
  solution lists).
- **Contamination exposure**: if seeded from a public repo, the plan must
  add counterfactual twists so no memorized implementation satisfies the
  sealed suite (same principle as the counterfactual-contract work in the
  [hard-repo-tasks archive experiment](https://github.com/nikhil-vytla/hatch/pull/5):
  familiar repositories are a distribution of constraints, not a source of
  old answers).

### Stage S2 — Plan: checkpoint partition

Final-state-first: draft the terminal spec $S_n^{\mathrm{merged}}$, then
partition backwards into stages, each labeled with its operator from the
algorithmic model (§2.4: extension / refinement / input-source /
re-modality), a single focus, and an out-of-scope list. Structural rules
enforced at this stage: first checkpoint defines the core problem;
no destructive steps; sizing per `checklist.md` (first checkpoint ≥ ~4 h
equivalent; later ones ≤ ~5 h given a well-factored prior solution — sizing
is estimated at plan time and verified against reference-build effort at G4).

### Stage S3 — Draft: specifications

One spec per checkpoint under the upstream discipline, mechanically lintable
where possible (`review-checklist.md` items: entrypoint placeholders, error
behavior as "Exit N, message to STDERR" without exact strings, no
language-specific constructs, no design-pressure paragraphs, examples for
happy path + edge + error).

### Stage S4 — Build: dual references and sealed suite

The critical departure from upstream, motivated by their own KNOWN_ISSUES
experience: **two independent reference implementations**, built
*incrementally* (each consumes its own prior-stage workspace, never the
final answer), by different agents or agent configurations, without seeing
each other or the test suite. The sealed suite is then written against the
spec, and disagreements between suite and either reference are triaged: a
case where the two references agree and the suite disagrees indicts the
suite; a case where the references disagree indicts the spec (ambiguity) and
loops back to S3.

### Stage S5 — Admit: gates G1–G6

The Evolving Intent-era admission matrix
([`scripts/admit.py` on the archive branch](https://github.com/nikhil-vytla/hatch/blob/cursor/hard-repo-tasks-5fc8/hard-repo-tasks/scripts/admit.py))
checks four things about a single task: gold passes, no-op fails, plausible
mutants fail, tampering fails. Checkpoint evolution needs the sequence-level
analog. A family is admissible iff all gates pass at every stage:

| Gate | Predicate | Sequence-level meaning | Automatable? |
| --- | --- | --- | --- |
| **G1 gold** | both references pass $\Omega_i$ at every $i$, built incrementally | solvable *as an evolution*, not just in the final state | yes |
| **G2 no-op** | the stage $(i{-}1)$ reference workspace fails $T_i$ for every $i$ | every checkpoint demands new work; no vacuous stages | yes |
| **G3 mutant/ambiguity** | (a) seeded semantic mutants of the references fail the suite; (b) the two references produce identical normalized outputs on the full sealed input space of the suite | suite discriminates; spec admits one behavior ("could two correct implementations differ?" from `checklist.md`, made executable) | yes |
| **G4 pressure** | naive-architecture reference (deliberately myopic at $C_1$, still correct) incurs ≥ $k\times$ the downstream churn/cost of the anticipatory reference | the sequence actually stresses design, the property upstream asserts by author judgment (Table 4) | yes, given the naive build |
| **G5 leakage/secrecy** | spec lint (structure hints, future-checkpoint mentions, exact-STDERR prescriptions) + sealed-side scan: no test content, verdicts, or measurement output reachable from the public capsule or workspace | authority separation across the whole family | partially — lint automates the checklist; residual semantic leakage needs review |
| **G6 headroom/difficulty** | a pinned frontier agent given $S_1$ alone does not pass the full family's suites (no one-shot); calibration runs show nonzero progress and sub-saturation strict rates | the family discriminates at the frontier, mirroring upstream's proposal-phase drop rule | yes (compute-priced) |

Gate receipts are retained as admission evidence in the frozen family.

### Stage S6 — Calibrate and freeze

Live runs across ≥ 2 pinned agents; record strict/ISO/core per stage,
RunFailure classification, and Class B measurements. A human reviews the
calibration evidence and the S1 brief's design-pressure narrative, then
signs the freeze. Post-freeze, specs and suites are immutable (fixes fork a
new family version with provenance).

## 3. Automatable now vs. human judgment — and why

**Automatable now** (deterministic or agent-executable with a checkable
artifact): S1 brief assembly; S2 partition against structural rules; S3
drafting + mechanical spec lint; S4 dual-reference builds and suite
construction; G1–G4 and G6 entirely — they are executions with pinned
inputs and byte-comparable outputs; the lint half of G5.

**Requires human judgment**, with the reason each time:

1. **Design-pressure naturalness** (S1/S6). G4 proves the sequence punishes
   a naive build, but not that the evolution is one a real product would
   undergo. Contrived pressure (arbitrary reversals dressed as refinements)
   passes every mechanical gate while measuring compliance rather than
   design skill. There is no computable oracle for "a competent engineer
   would find this a plausible roadmap" — this is a construct-validity
   judgment, the same class of judgment MODEL.md leaves to admission review.
2. **Residual semantic leakage** (G5). The lint catches the checklist items;
   it cannot certify that no sentence *implies* the hidden decomposition
   (upstream's own example: an embedded output example that quietly fixes a
   sort order is *good* normalization, while a sentence praising "clean
   separation between X and Y" is leakage — the difference is judgment).
3. **Ambiguity triage** (S4). Which party is wrong when references and suite
   disagree is decidable mechanically; *what the spec should have said* is
   authorial.
4. **Freeze sign-off** (S6). Calibration numbers say the family
   discriminates; whether the failures look like the intended failure mode
   (design debt) rather than spec lawyering or trivia requires reading
   transcripts. Upstream did exactly this in their validation phase.

The honest summary: generation is automatable; *admission is where honesty
lives*, and two of six gates keep a human in them.

## 4. Cursor skill specifications

Specs only — none of these exist. Each skill's output is a typed artifact so
the next stage (and the gates) can validate mechanically.

**Skill `assess-checkpoint-seed`** (S1)
- *Inputs*: seed locator (repo URL + revision, tool name, or benchmark task
  family ID); constraint profile (language track, budget class).
- *Outputs*: `decomposability-brief.json` — contract sketch, axes of
  variation, named naive + anticipatory architectures, contamination notes,
  scored rubric with per-criterion evidence, accept/reject recommendation.
- *Validation*: schema check; every score must cite evidence fields;
  rejection reasons drawn from a closed enum.

**Skill `plan-checkpoint-family`** (S2)
- *Inputs*: accepted brief.
- *Outputs*: `family-plan.json` — terminal spec summary; ordered checkpoints
  each with operator label, single-focus statement, out-of-scope list,
  predicted churn locus for the naive architecture.
- *Validation*: structural rules (first-checkpoint immutability, no
  destructive steps, operator labels from the closed set, 3–8 stages);
  anti-leakage: no stage references a later stage's content.

**Skill `draft-checkpoint-specs`** (S3)
- *Inputs*: family plan.
- *Outputs*: `checkpoint_N.md` set + `config.yaml` in the upstream problem
  layout.
- *Validation*: mechanical spec lint implementing the `review-checklist.md`
  items (entrypoint placeholders, error-form rules, example coverage,
  language-agnosticity, no design-pressure paragraphs).

**Skill `build-sealed-family`** (S4)
- *Inputs*: spec set; two isolated builder configurations.
- *Outputs*: two incremental reference workspaces per stage; sealed pytest
  suite + case data per stage; disagreement triage report.
- *Validation*: references built without suite access (enforced by
  isolation, recorded in provenance); suite runs green on both references;
  triage report empty or resolved before handoff to G-gates.

**Skill `admit-checkpoint-family`** (S5)
- *Inputs*: frozen candidate family (specs, suites, references, naive
  reference).
- *Outputs*: `admission-receipt.json` — per-gate verdicts G1–G6 with
  digests, churn/cost ratios, mutant kill lists, lint findings, and the
  open items requiring human review.
- *Validation*: receipt schema; any gate failure blocks freeze; human-review
  items cannot be auto-waived.

## 5. Honest assessment: can this match hand-authored quality?

Grounds for yes: upstream's own process is mostly checklist-shaped; its
non-mechanical core ("does this test design decisions?") is exactly what G4
operationalizes, arguably more rigorously than author intuition; and the
hand-authored baseline includes a 14% reference-solution defect rate that
G1's dual-incremental-reference requirement is specifically built to beat.
Agent-assisted *validation* (S4/G3) also scales past what the authors did —
they ran one agent per checkpoint to shake out ambiguity; dual independent
references plus mutant kills is a strictly stronger regimen.

Grounds for doubt: seed taste and roadmap naturalness are where the paper's
problems get their credibility (EVE industry chains, ast-grep-like search —
tools the authors knew deeply), and S1 is the stage with the least
verifiable output. A generated family can pass every gate and still be a
sterile puzzle. That risk concentrates in exactly the two human-judgment
points above, which is why they are gates rather than suggestions.

What would settle it (the experiment is itself runnable under this
workflow): author $k$ families by this pipeline and take $k$
hand-authored SCBench problems of matched size; run the same pinned agent
panel on both; compare (a) model *ranking* agreement between the two sets,
(b) strict-rate headroom and per-stage discrimination, (c) degradation-slope
distributions, (d) post-freeze defect discoveries per family, and (e) blind
expert preference on spec quality. Ranking agreement with comparable
headroom and no excess defect rate is the match criterion; systematic
divergence localizes which stage of the pipeline loses fidelity.

> Claim limit: this workflow is a design. No stage, gate, or skill has been
> executed; the defect-rate comparison and settling experiment are
> proposals.
