# Disambiguation report: the stage-3 separation was the instrument

Executed 2026-08-03, completing 23:21 PT, per
[PREREGISTRATION-HEADROOM.md](PREREGISTRATION-HEADROOM.md), committed
before spend. Evidence:
[`evidence/screening-headroom.jsonl`](evidence/screening-headroom.jsonl),
machine summary `evidence/screening-headroom-summary.json`. Companion
to the first run's [screening-report.md](screening-report.md).

## Verdict, bluntly

**The original stage-3 separation was manufactured by our instrument,
not by self-accumulation.** With the byte pressure removed and nothing
else changed, the evolved arm verified **strict 10/10 at every stage**,
verdict-identical to carry-reference: paired strict differences with
bounds [0, 0] at stages 2 and 3, zero RunFailures of any kind, 60/60
stage calls delivered and validated, receipt chain confirmed 60/60.
H-instrument, as preregistered: full-file-map replies plus the flat
4096-byte cap guaranteed the failure, because the evolved arm is the
only arm that must re-emit its own accumulated workspace inside the
same cap.

## The three-way picture

| | Original run (`ce-tally-1`, flat 4096 caps, 2048 tokens) | Variant run (`ce-tally-1-headroom`, caps 4096/8192/12288, 4096 tokens) | What the difference licenses |
|---|---|---|---|
| Stages 1–2 | strict 20/20 runs, both arms | strict 20/20 runs, both arms | agreement; unaffected by the lever |
| Stage 3, carry arm | strict 10/10 | strict 10/10 | carry never felt the cap |
| Stage 3, evolved arm | **0/10 verifiable** — all budget RunFailures at 4802–4864 bytes vs the 4096 cap | **strict 10/10** — outputs 2601–4851 bytes, comfortably inside 12288 | the only changed variable is the mechanical output ceiling, so the original failure was the ceiling, not the accumulation |
| Paired strict contrast | stage 3 undecidable (vacuous bounds [−10, +10]) | stage 3 observed 0, bounds [0, 0] | no verdict-level self-accumulation effect at this scale |
| Spend | $0.2813 | $0.2796 | — |

Same 10 seeds (101–110), same specs, sealed cases, references, model
(`claude-haiku-4-5-20251001` reported on all 120 calls across both
runs), same sandbox, same evidence pipeline.

## What survives as a real finding

The *accumulation* itself is real and measurable — it just lands in
cost and bloat, not in verification, once the instrument stops
converting it into failure:

- Evolved workspaces grow well past carry's at every later stage:
  stage 2 evolved 2403–3774 bytes vs carry 1361–1627; stage 3 evolved
  2601–4851 vs carry's uniform 2082. The evolved stage-3 maximum
  (4851) exceeds the original 4096 cap — consistent with the original
  failure being mechanical.
- The evolved arm cost 1.52× the carry arm ($0.1687 vs $0.1108) on an
  identical schedule, because its own carried verbosity is re-billed
  as input tokens every stage.

At this scale (one family, one model) these are hypothesis-generating
observations for the Class B quality panel, which is where
verbosity/bloat belongs — not grounds for any verification-decay
claim.

## The design constraint this bought

Arms can be *nominally* budget-matched (identical declared caps) while
*effectively* unmatched, because the manipulation itself changes how
many bytes an arm must emit: with full-file-map replies the evolved
arm's guaranteed room for new content is the **cap increment** (the
carried workspace is bounded only by the previous cap), and flat caps
guarantee an increment of zero. This is now:

- written into the method doc
  (`docs/methods/checkpoint-evolution.md`, "Controlled comparison") as
  a design constraint for future families;
- enforced structurally: `budget_headroom_violations`
  (`src/parallax/checkpoint_evolution.py`) requires the stage-1 cap to
  cover 2× the stage-1 reference and every cap increment to cover 2×
  the reference increment, and the live screening path refuses to
  spend on a violating family (`BudgetMatchingError`; gauntlet mutant
  M25 kills the refusal's removal). The original flat-cap family fails
  this rule at stages 2 and 3 — the gate would have caught the
  confound before the first paid call.

## Status of the first run's conclusions

- The first run's harness-gate conclusions stand: delivery, receipts,
  digest chains, sandboxing, metering, and failure classification all
  behaved correctly in both runs (120/120 stage calls, zero
  infrastructure failures, ~$0.56 total spend).
- The first run's stage-3 *contrast* is reclassified: it measured the
  interaction of reply format × cap schedule, not agent degradation.
  Its report now points here.
- "Proceed to multi-family synthesis" still holds, now with the
  headroom rule enforced on every future family, and with cap
  schedules and reply format recorded as design parameters that must
  be preregistered, not incidental settings.
