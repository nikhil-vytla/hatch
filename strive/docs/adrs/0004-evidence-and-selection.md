# ADR-0004 — Validation bundles and selection decisions

Status: accepted design; wire schemas PROVISIONAL until this ADR's implementation slice (see adrs/README freeze table). Refines D14.

## Context

Today's `Decision` record hard-codes the paired-deterministic world: two
scalar scores, two split-score maps, a regression list. Stochastic validation
(distributions over repeated trials), hard constraints (budget/latency
ceilings), Pareto retention (a candidate kept without dethroning anyone), and
provisional outcomes don't fit two scalars — and widening the ledger schema
for each new policy would churn versions forever.

## Decision

**Two stable envelopes; policy-specific detail lives in referenced
artifacts.**

`ValidationBundle` — what the evidence *is*:
- `evaluation_manifest_ref` (ADR-0003) — everything the validation ran
  under. **Bundles own evaluation manifests; revisions never do** — one
  revision is evaluated under many manifests over its life, and a test pins
  exactly that scenario;
- `subject: RevisionRef` (globally unambiguous, ADR-0001);
- `results: tuple[ValidatorResult, ...]` where each result carries
  `validator` (name@version), `status ∈ {passed, failed, inconclusive}`,
  a flat `metrics: dict[str, float]` (means, CIs, trial counts — whatever the
  validator emits), a human `detail`, and an optional `artifact_ref` into CAS
  for the full payload (per-trial scores, distributions, traces). The ledger
  never grows per-policy fields; it grows CAS artifacts.

`SelectionDecision` — what was *concluded*, **policy-neutral**:
- `policy_ref` (name@version — resolved by name AND version, exactly as
  replay already requires) — the policy's own comparison method (paired,
  stochastic, hard-constraint, Pareto dominance…) is the policy's business
  and lives in the evidence artifacts, not in a kernel-visible `kind` field;
- `objective_spec_ref` — the versioned objective/constraint spec (ADR-0005)
  the decision was made against, pinned on every decision;
- `disposition ∈ {promote, reject, frontier_add, provisional_activate}` —
  the small kernel vocabulary of things the kernel will *do*. `frontier_add`
  (renamed from `retain`) is the population disposition: the candidate joins
  the frontier without becoming the incumbent (GEPA's Pareto retention as a
  disposition, note 01);
- `subject: RevisionRef`, `incumbent: RevisionRef | None` (null for
  population-only comparisons); Pareto comparand sets travel in the evidence
  artifact;
- `evidence_refs: tuple[str, ...]` — the bundles this conclusion rests on;
- `rationale` — one human sentence;
- `at`.

**Invariants** (kernel-enforced, policy-independent): **every disposition —
promote, reject, frontier_add, and provisional_activate — requires evidence
bundles** (a rejection without evidence is as unauditable as a promotion
without it); a `promote` additionally requires evidence whose manifest
matches the current dataset revision; every decision is journaled whatever
the disposition; the disposition vocabulary is closed (schema bump to
extend).

**Compatibility.** Today's `Decision` maps mechanically: policy_ref
`paired-deterministic@1`, disposition `promote|reject`, one synthetic bundle
with two `ValidatorResult`s (baseline suite, candidate suite) whose metrics
carry the split scores, regression ids in the artifact payload. Existing
policies keep their names and versions; today's implicit objective becomes
the first `ObjectiveSpec` artifact.
Stage 3B writes new envelopes alongside `decision@1` inside `generation`
records until the revision migration lands, then replaces them.

## Consequences

- `strive compare`/`replay` re-derive their reports from bundles instead of
  the decision's inline scores; replay's "compare beyond the boolean" check
  becomes "recompute bundle metrics and diff".
- The stall detector keys on decisions with verdict ≠ promote plus flat
  bundle metrics, unchanged in spirit.
- Statistical acceptance (stage 4) is a new validator + policy, zero schema
  change: distributions live in the bundle's artifact.

## Sources: borrowed / rejected / deferred

- **Borrowed** — GEPA: score-plus-feedback results and Pareto retention
  (note 01); NOOA: evidence artifacts referenced, not inlined (note 06);
  exo: conclusions journaled with refs to immutable evidence (note 04).
- **Rejected** — CH's no-decision model (behavioral triage only, note 03);
  free-form verdict strings (closed vocabulary or the ledger becomes prose).
- **Deferred** — inheritance-aware thresholds as a first-class policy (needs
  usage-share statistics); multi-objective weight specs beyond what
  ADR-0005's objective spec carries; cross-task promotion manifests
  (ADR-0002) until prompts are evolvable.
