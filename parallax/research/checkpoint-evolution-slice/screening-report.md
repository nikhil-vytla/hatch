# Checkpoint-evolution screening report (first paid run)

> **Superseded on the headline contrast.** The stage-3 separation
> reported below was manufactured by the instrument (flat byte caps ×
> full-file-map replies), not by self-accumulation: the preregistered
> disambiguation run removed byte pressure with everything else
> unchanged and the separation vanished completely. See
> [disambiguation-report.md](disambiguation-report.md). The
> harness-gate conclusions below stand.

Executed 2026-08-03, 22:33–22:39 PT, against the preregistered design in
[PREREGISTRATION-DRAFT.md](PREREGISTRATION-DRAFT.md). Evidence:
[`evidence/screening.jsonl`](evidence/screening.jsonl) (22 canonical
records), machine summary
[`evidence/screening-summary.json`](evidence/screening-summary.json),
produced by [`summarize_screening.py`](summarize_screening.py).

## Headline

All 60 preregistered stage calls were delivered and produced validated
evidence. The two arms separated completely at stage 3: the
`carry-reference` arm verified **strict on 10/10 seeds**, while the
`evolved` arm — carrying its own prior workspace — exceeded the declared
4096-byte workspace budget on **10/10 seeds** (attempted 4802–4864
bytes, +17–19% over cap) and produced no verifiable stage-3 workspace at
all. Actual metered spend: **$0.2813**, inside the preregistered
$0.25–$0.50 estimate and far under the $5 cap.

## What ran

| Field | Preregistered | Executed |
|---|---|---|
| Family | `ce-tally-1`, digest `7704…274d` | same (digest match in manifest and family record) |
| Design | 10 seeds × 2 arms × 3 checkpoints = 60 calls | 60/60 delivered, design digest `24e2…69ac` |
| Model | `claude-haiku-4-5` via the HUD gateway | reported `claude-haiku-4-5-20251001` on every call (drift check passed) |
| Verification | container sandbox, no host fallback | `model_config.execution = sandbox:python@sha256:57cd7c…710de` |
| Budgets | 4096-byte workspace cap, 2048 max output tokens | enforced; see stage-3 outcome |
| Wall time | — | 5 m 38 s, no retries, no gateway errors |

## Per-seed, per-arm, per-stage outcomes

Identical across all 10 seeds (trial seeds do not enter the prompt;
temperature 0; the provider still produced 2–3 distinct byte-level
outputs per stage, all verifying identically):

| Arm | Stage 1 | Stage 2 | Stage 3 |
|---|---|---|---|
| `evolved` (10 seeds) | strict | strict | RunFailure(budget): reply workspace 4802–4864 bytes > 4096 cap |
| `carry-reference` (10 seeds) | strict | strict | strict |

Every verified stage passed at the *strict* level (full accumulated
obligation set Ω_i); no stage was isolated-only or core-only. The 10
budget failures are the only failures of any kind: **RunFailure rate
10/60 = 16.7%** (stop rule threshold: 30%), all of kind `budget`, none
infrastructure (`verifier`/`agent` count: 0).

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

Mechanism, as recorded in the receipts: both arms behave identically at
stage 1 (same delivery, byte-identical replies on several seeds). From
stage 2 onward the evolved arm re-serializes its own verbose stage-1
workspace (~1.7 KB) and grows it to ~3.7 KB; its stage-3 full-file-map
reply then lands at 4802–4864 bytes, over the declared 4096-byte cap.
The carry arm, re-opened each stage from the lean reference workspace,
answers stage 3 in 2077 bytes and passes strict. That is the
self-accumulation signature RQ1 asks about, surfacing as budget
pressure from the agent's own carried verbosity rather than as a
semantic regression.

Claim limits: one family is one cluster; one model, one budget setting;
no clustered interval is claimed. The separation is a property of this
family's byte budget interacting with this model's verbosity. A design
with a looser cap (or a diff-based reply format) could show a different
— or no — separation.

## Decision per preregistration

- Complete, validated evidence for 60/60 = **100%** of scheduled stage
  calls (threshold ≥ 90%) → **Proceed** to multi-family synthesis
  (workflow S1–S6).
- RunFailures 16.7% < 30% and zero evidence-validation errors → the
  "fix first" branch is not triggered. The uniform stage-3 budget
  failure is real agent behavior under the declared budget, faithfully
  classified — but the next design should preregister the budget/reply
  format question explicitly (cap chosen vs. reference size ×
  headroom, full file map vs. delta replies).

## Spend

| | Prompt tokens | Completion tokens | Estimated cost |
|---|---|---|---|
| `evolved` arm (30 calls) | 27,366 | 28,951 | $0.1721 |
| `carry-reference` arm (30 calls) | 20,240 | 17,786 | $0.1092 |
| **Total (60 calls)** | **47,606** | **46,737** | **$0.2813** |

(The evolved arm costs ~1.6× the carry arm for the same schedule — its
own accumulated verbosity is billed back to it as input tokens.)
