# Checkpoint-evolution screening report (first paid run)

Executed 2026-08-03, 22:33–22:39 PT, against the preregistered design in
[PREREGISTRATION-DRAFT.md](PREREGISTRATION-DRAFT.md). Evidence:
[`evidence/screening.jsonl`](evidence/screening.jsonl) (22 canonical
records), machine summary
[`evidence/screening-summary.json`](evidence/screening-summary.json),
produced by [`summarize_screening.py`](summarize_screening.py).

## Headline

All 60 preregistered stage calls were delivered and produced validated evidence.
The two arms separated completely at stage 3: `carry-reference` verified **strict
on 10/10 seeds**, while `evolved`, carrying its own prior workspace, exceeded the
declared 4096-byte workspace budget on **10/10 seeds** (4802 to 4864 bytes
attempted, 17 to 19% over cap) and produced no verifiable stage-3 workspace at
all. Metered spend was **\$0.2813**, inside the preregistered \$0.25 to \$0.50
estimate and far under the \$5 cap.

The separation is real and it is not the result the method predicts. It happened
at the budget boundary, before verification, so read the
[contrast](#contrast-bounds-only-hypothesis-generating) section before quoting
this run for anything.

## What ran

| Field | Preregistered | Executed |
|---|---|---|
| Family | `ce-tally-1`, digest `7704…274d` | same (digest match in manifest and family record) |
| Design | 10 seeds × 2 arms × 3 checkpoints = 60 calls | 60/60 delivered, design digest `24e2…69ac` |
| Model | `claude-haiku-4-5` via the HUD gateway | reported `claude-haiku-4-5-20251001` on every call (drift check passed) |
| Verification | container sandbox, no host fallback | `model_config.execution = sandbox:python@sha256:57cd7c…710de` |
| Budgets | 4096-byte workspace cap, 2048 max output tokens | enforced; see stage-3 outcome |
| Wall time | not preregistered | 5 m 38 s, no retries, no gateway errors |

## Per-seed, per-arm, per-stage outcomes

Identical across all 10 seeds. Trial seeds do not enter the prompt and
temperature is 0, yet the provider still produced 2 to 3 distinct byte-level
outputs per stage, all verifying identically.

| Arm | Stage 1 | Stage 2 | Stage 3 |
|---|---|---|---|
| `evolved` (10 seeds) | strict | strict | RunFailure(budget): reply workspace 4802 to 4864 bytes against a 4096 cap |
| `carry-reference` (10 seeds) | strict | strict | strict |

Every verified stage passed at the *strict* level, against the full accumulated
obligation set Ω_i. No stage was isolated-only or core-only. The 10 budget
failures are the only failures of any kind: **RunFailure rate 10/60 = 16.7%**
against a 30% stop rule, all of kind `budget`, with zero `verifier` or `agent`
failures.

## Delivery and receipt confirmation

All 22 evidence records validate against the typed models
(`CeManifestRecord`, `CeFamilyRecord`, `CeRunRecord`), which enforce
contiguous delivery, spec-digest fidelity, and censoring-as-suffix. The
workspace-digest chain was confirmed for **60/60 receipts**: stage 1
always opens from the empty workspace; each `evolved` stage-i input
digest equals that run's own stage-(i−1) output digest; each
`carry-reference` stage-i input digest equals the frozen reference
workspace for stage i−1. Per-stage usage is metered on all 60 receipts,
including the 10 failed stages (spend happened before the reply was
rejected).

## Contrast (bounds-only, hypothesis-generating)

- **Stage 2** paired strict difference (evolved − carry): observed **0**
  over 10/10 decidable pairs; bounds [0, 0].
- **Stage 3**: no pair is decidable at the verdict level, because every
  evolved stage-3 reply was rejected at the budget boundary before
  verification; verdict-level bounds are the vacuous [−10, +10]. The
  operational contrast is complete separation one level up:
  **verifiable stage-3 workspaces 0/10 (evolved) vs 10/10 (carry)**.

Mechanism, as recorded in the receipts: both arms behave identically at stage 1,
same delivery and byte-identical replies on several seeds. From stage 2 onward the
evolved arm re-serializes its own verbose stage-1 workspace (~1.7 KB) and grows it
to ~3.7 KB. Its stage-3 full-file-map reply lands at 4802 to 4864 bytes, over the
declared 4096-byte cap. The carry arm, reopened each stage from the lean reference
workspace, answers stage 3 in 2077 bytes and passes strict.

That is consistent with the self-accumulation effect RQ1 asks about, and it is
equally consistent with a reply format that makes carried state expensive to
restate under a cap we picked. This run cannot tell those apart. It surfaced as
budget pressure, not as semantic regression, and no evolved stage-3 workspace was
ever graded, so the run contains no evidence about verification decay in either
direction.

Claim limits: one family is one cluster, one model, one budget setting, no
clustered interval claimed. The separation is a property of this family's byte
budget meeting this model's verbosity. A looser cap or a diff-based reply format
could show a smaller separation, or none. A follow-up run varying exactly those
two settings is the next step, and until it lands this row is unresolved.

## Decision per preregistration

The preregistered bar was harness validation, not a contrast: proceed to
multi-family synthesis (workflow S1 through S6) on complete validated evidence
for at least 90% of scheduled stage calls, whatever the arms show. This run
delivered 60/60, so that bar is met.

RunFailures at 16.7% sit under the 30% stop rule and there were zero
evidence-validation errors, so "fix first" is not triggered. The uniform stage-3
budget failure is real agent behavior under the declared budget, faithfully
classified. What it changes is the next preregistration: the cap and the reply
format have to be declared questions rather than incidental settings. Cap chosen
against reference size times a headroom factor, and full file map against delta
replies.

## Spend

| | Prompt tokens | Completion tokens | Estimated cost |
|---|---|---|---|
| `evolved` arm (30 calls) | 27,366 | 28,951 | \$0.1721 |
| `carry-reference` arm (30 calls) | 20,240 | 17,786 | \$0.1092 |
| **Total (60 calls)** | **47,606** | **46,737** | **\$0.2813** |

The evolved arm costs about 1.6 times the carry arm on an identical schedule,
because its own accumulated verbosity is billed back to it as input tokens. That
is the one clean quantitative finding in this run.
