Four hardcoded token-pricing tables in Parallax meant several paid runs wrote
their receipts against the retired Opus 4.1 rate card, and one of them priced
Haiku 4.5 construction calls through it too, so the dollar figures stored in
committed evidence overstate spend by up to fifteen times. Because token counts
were always retained, [`audit_spend.py`](audit_spend.py) recovers the truth by
ignoring every recorded dollar and re-metering from tokens through the single
canonical table in [`parallax.metering`](../../src/parallax/metering.py), while
asserting each cache-replay relation so a resumed run's replayed episodes are
not counted twice. The audit puts total spend across all four paid runs at
$4.991133 metered, or $5.30–$5.53 including two unmetered gaps that are stated
as bounds because [HUD](https://www.hud.so/) exposes no gateway-log retrieval
endpoint. Historical evidence files are left as written with correction notes
placed beside them, and a test fails offline if the ledger stops matching the
evidence.

- Screening round 1 cost $0.518250, not the $1.669650 on record; its Haiku
  construction receipts were fifteen-fold over and its episode receipts
  three-fold.
- Screening round 2's widely quoted $2.972512 is correct and token-derived,
  though naively summing that folder's receipts gives $8.544627.
- The single-vs-evolved contrast's $1.219080 reproduces two independent ways;
  what was wrong there was the unmetered band for its first crashed run,
  $0.31–$0.52 rather than $0.40–$0.80.
- Checkpoint-evolution screening cost $0.281291, matching its published figure.
