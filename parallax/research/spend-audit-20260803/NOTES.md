# Spend audit, 2026-08-03

Working notes. The task: establish what every paid Parallax run to date
actually cost, before a findings table quotes a receipt sum as the headline
number.

## Why the receipts cannot be trusted

- Token pricing was hardcoded in four places. One of them was the retired Opus
  4.1 rate card, $15/$75 per million input/output tokens, three times Opus
  4.8's $5/$25.
- Worse, the construction path priced Haiku 4.5 calls through the same Opus
  constant, a fifteen-fold overstatement ($1/$5 actual).
- Token counts were always retained correctly, so every historical figure is
  recoverable. This audit ignores recorded dollars entirely and re-meters from
  tokens through `parallax.metering`, the single canonical table introduced by
  the consolidation PR.

## What made the arithmetic non-obvious

- Resumes replay cached episodes, and a replayed episode carries its original
  cost into the new evidence file. Summing files double-counts. `audit_spend.py`
  declares each replay relation and asserts it: shared units must carry
  identical token counts, or the "replay" actually re-paid and the audit fails.
- Two crashes destroyed episodes that had already been paid for and were then
  re-paid in the next session. Those are two real payments, so the audit counts
  the payment where it was made and counts the replacement again later. This is
  what `account_spend.py` established for the single-vs-evolved run; the audit
  reproduces its $1.219080 total from tokens alone, which is a useful
  independent check on both.
- Zero-token rows are not all the same. Round 1's preflight failures, round 2's
  compile-time leak-scan rejections, and round 2's Docker disk failures all
  aborted *before* inference and genuinely cost nothing. The single-vs-evolved
  run 1 rows recorded zero because the pre-fix failure path raised before
  capturing usage on episodes that had already run and been billed. Only the
  latter is an unmetered gap.

## Findings per run

- Round 1: $0.518250 metered, not the $1.669650 on record. Construction was
  15x over (Haiku priced as retired Opus), episodes 3x over. The $0.477790
  reserve for three usage-less construction responses becomes $0.022779 on the
  same conservative method at Haiku rates, so the all-in bound is $0.541029,
  not $2.147440.
- Round 2: $2.972512 is correct and token-derived. This was the number most at
  risk, so it is worth stating why it survives: the round recalculated its cost
  from retained tokens after discovering the stale constant, and the six
  components in `round2-report.json` reconcile exactly with a fresh per-file
  re-metering. A naive sum of that folder's receipts gives $8.544627.
- Single-vs-evolved: $1.219080 metered, token-derived and reproduced two ways.
  The run-1 unmetered band was wrong, though: $0.40-0.80 was extrapolated from
  retired-rate round-2 averages. Priced at what those exact astropy units cost
  when re-run, the band is $0.31-0.52, giving $1.53-1.74 all-in.
- Checkpoint-evolution: $0.281291, token-derived at correct Haiku rates,
  matching the $0.2813 on record. The two dry runs never contacted a provider.

## Loose ends

- The three unmetered round-1 construction calls and the three-to-four
  unmetered run-1 episodes are unrecoverable: HUD documents token usage in its
  platform logs but exposes no gateway-log retrieval endpoint. Both are stated
  as bounds, not point figures.
- Construction receipts record `reported_model` as a dated snapshot
  (`claude-haiku-4-5-20251001`) while `MODEL_PRICING` keys the base model. The
  audit re-meters by `requested_model` and asserts the reported snapshot is a
  snapshot of it, so a substituted model would fail rather than be priced
  against the wrong card.
- No other committed research folder contains usage-bearing evidence, so these
  four runs are the whole paid history on this branch. The GSM8K run executing
  in another worktree is not in this evidence and is not counted.
