# What Parallax's paid runs actually cost

Every dollar figure below is recomputed from the token counts retained in
committed evidence, at the canonical rates in
[`parallax.metering`](../../src/parallax/metering.py). Recorded
`estimated_cost_usd` fields are reported only for contrast, because several
were written against the retired Opus 4.1 rate card ($15/$75 per million) and
some priced Haiku 4.5 work through it as well.

Reproduce with:

```bash
uv run python research/spend-audit-20260803/audit_spend.py
```

The script writes [`spend-ledger.json`](spend-ledger.json) and fails rather
than guesses: an unknown model has no rate, and a supposed cache replay whose
token counts moved is treated as a re-payment error, not silently merged.

## Authoritative figures

| Run | Metered (token-derived) | Unmetered | All-in | Receipts as written |
| --- | --- | --- | --- | --- |
| Screening round 1 (`swebench-screening-run-20260802`) | $0.518250 | ≤ $0.022779 | ≤ $0.541029 | $3.195675 |
| Screening round 2 (`swebench-screening-round2-20260803`) | $2.972512 | none | $2.972512 | $8.544627 |
| Single-vs-evolved (`swebench-single-vs-evolved-20260803`) | $1.219080 | $0.31–$0.52 | $1.53–$1.74 | $2.359640 |
| Checkpoint-evolution screening (`checkpoint-evolution-slice`) | $0.281291 | none | $0.281291 | $0.281291 |
| **Total** | **$4.991133** | | **$5.30–$5.53** | $14.381233 |

The "receipts as written" column is what a naive sum over each folder's
evidence files produces. It is wrong twice over: it prices Opus 4.8 and Haiku
work at retired Opus 4.1 rates, and it counts cache-replayed episodes once per
file they appear in.

## Which figures are solid, and which are bounds

- **Round 2's $2.972512** is token-derived at correct current rates. The round
  found the stale constant itself and recalculated; a fresh per-file
  re-metering reconciles exactly with the six components in
  `round2-report.json`. This was the figure most at risk and it holds.
- **The single-vs-evolved $1.219080** is token-derived and confirmed twice: by
  this audit, and by `account_spend.py`'s independent session attribution.
- **The checkpoint-evolution $0.281291** is token-derived at Haiku rates and
  matches the $0.2813 already published.
- **Round 1's $0.518250** replaces the $1.669650 on record. The receipts there
  were written at retired rates and its Haiku construction receipts were
  overstated fifteen-fold.
- **Two gaps are bounds, not figures.** Round 1 lost usage on three
  construction responses whose failure path raised before capture; that reserve
  keeps the original conservative method (a token per prompt byte plus the full
  output allowance) at correct Haiku rates. The single-vs-evolved run 1 lost
  three-to-four already-billed episodes the same way; those are priced at what
  the same units cost when re-run. Neither is recoverable — HUD exposes no
  gateway-log retrieval endpoint.

## What was corrected where

Committed evidence files are left exactly as written. Corrections are notes
placed beside them:

- `swebench-screening-run-20260802/README.md` and `NOTES.md` — correction note
  and a component table for the retired-rate error.
- `swebench-single-vs-evolved-20260803/README.md` and `NOTES.md` — corrected
  unmetered band and all-in range; `account_spend.py` now carries the corrected
  band with the superseded one beside it.
- `swebench-screening-round2-20260803/README.md` — a warning that its evidence
  receipts still hold retired-rate values, so the report's figure is the one to
  quote.
- `parallax/README.md` — round-1 spend corrected in place.

## Why a script rather than another paragraph

Four hardcoded pricing tables produced one stale rate card, which produced
several wrong published figures, which nearly became a findings-table headline.
The consolidation PR removed the duplicate tables; this folder removes the
duplicate arithmetic. The spend history is now a command that reads committed
evidence, not a number copied between documents.
