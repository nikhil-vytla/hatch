# ADR-0004 — Validation bundles and selection decisions

Status: accepted (Stage 3A). Refines D14.

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
- `manifest_ref` (ADR-0003) — everything the validation ran under;
- `subject_revision_id`;
- `results: tuple[ValidatorResult, ...]` where each result carries
  `validator` (name@version), `status ∈ {passed, failed, inconclusive}`,
  a flat `metrics: dict[str, float]` (means, CIs, trial counts — whatever the
  validator emits), a human `detail`, and an optional `artifact_ref` into CAS
  for the full payload (per-trial scores, distributions, traces). The ledger
  never grows per-policy fields; it grows CAS artifacts.

`SelectionDecision` — what was *concluded*:
- `policy` + `policy_version` — resolved by name AND version, exactly as
  replay already requires;
- `kind ∈ {paired-deterministic, stochastic, hard-constraint, provisional,
  pareto-retention}`;
- `verdict ∈ {promote, reject, retain, provisional}` — `retain` is the
  population verdict: the candidate joins/stays on the frontier without
  becoming the incumbent (GEPA's Pareto retention as a *verdict*, note 01);
- `subject_revision_id`, `incumbent_revision_id` (null for population-only
  comparisons), and for Pareto kinds the comparand set travels in the
  evidence artifact;
- `evidence_refs: tuple[str, ...]` — the bundles this conclusion rests on;
- `rationale` — one human sentence;
- `at`.

**Invariants** (kernel-enforced, policy-independent): a `promote` verdict
requires at least one evidence bundle whose manifest matches the current
dataset revision; every decision is journaled whatever the verdict; verdicts
and kinds are closed vocabularies (schema bump to extend).

**Compatibility.** Today's `Decision` maps mechanically: kind
`paired-deterministic`, verdict `promote|reject`, one synthetic bundle with
two `ValidatorResult`s (baseline suite, candidate suite) whose metrics carry
the split scores, regression ids in the artifact payload. Existing policies
(`paired-deterministic@1`, `provisional@1`) keep their names and versions.
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
