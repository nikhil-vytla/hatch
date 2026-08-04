# Single-vs-evolved SWE-bench experiment (2026-08-03)

Executes the preregistered 18-unit experiment comparing a static
single-turn prompt against an evolved harness-delivered two-phase prompt:
3 admitted boundary instances x 2 conditions x 3 paired trials, Claude
Opus 4.8 through the HUD OpenAI-compatible gateway, official SWE-bench
harness grading in local Docker (`linux/amd64`, pinned harness revision
`f7bbbb2ccdf479001d6467c9e34af59e44a840f9`). The design was preregistered
in `../swebench-experiment-prerequisites-20260803/` (design digest
`e230043c...`); `evidence/preregistration-linkage.json` links it to the
executed plan digest `175dc952...` with exact unit correspondence.

## Results

All 18 preregistered units verified through the official harness; no unit
was scored by anything other than the pinned harness, and none remains a
run failure.

| Instance | Condition | T0 | T1 | T2 | Passes |
|---|---|---|---|---|---|
| astropy__astropy-14508 | static | wrong | pass | pass | 2/3 |
| astropy__astropy-14508 | evolved | wrong | pass | wrong | 1/3 |
| django__django-13786 | static | pass | pass | pass | 3/3 |
| django__django-13786 | evolved | pass | pass | pass | 3/3 |
| pydata__xarray-4695 | static | wrong | wrong | wrong | 0/3 |
| pydata__xarray-4695 | evolved | wrong | wrong | wrong | 0/3 |

Paired analysis (`evidence/experiment-report.json`), estimand
single-minus-evolved pass rate:

- 9/9 pairs complete, so the identification bounds are degenerate at the
  point estimate: **+0.111** (source-level means +0.333, 0, 0).
- The source-clustered Hoeffding MDE at 95% is **1.568** with only 3
  sources, so the interval is the trivial [-1, 1]. The experiment is
  nowhere near powered for the +/-0.2 decision threshold. Bounds-only
  language applies: the data neither advances nor rejects either
  condition; it only records these bounds.

Delivery confirmation: every evolved episode carries a complete two-phase
receipt (6+6 steps, `budget_exhaustion` then `terminal_budget_exhaustion`)
and every static episode a single 12-step phase, so both conditions
consumed exactly the equal 12-step budget. `all_evolved_units_delivered`
and `all_units_delivered` are both true in the report.

## Spend

Replayed units carry their original cost into later evidence files, so
`account_spend.py` counts unique payments
(`evidence/cross-session-spend.json`):

| Session | New payments |
|---|---|
| Run 1 (delivery-wire defect) | \$0 metered; ~4 episodes unmetered, est. \$0.40-0.80 |
| Run 2 (frame-limit defect, incl. orphan) | \$0.349545 |
| Run 3 (gateway connection failures) | \$0.681200 |
| Run 4 (final recovery) | \$0.188335 |
| **Unique metered total** | **\$1.219080** |

The total reconciles exactly: final-file sum \$1.105265 plus the destroyed
run-2 evolved trial-0 episode (\$0.045470) plus the five destroyed run-3
xarray partials (\$0.068345). With the run-1 unmetered estimate the all-in
figure is roughly \$1.62-2.02, well inside the \$25 defect-stop cap.

## Disposition of failure receipts

- `experiment-delivery-wire-failure.jsonl` (+summary): superseded by
  recovery. Strict python-mode receipt parsing was fixed in
  `hud_screening.py` (JSON-mode validation, regression-tested) and all
  three recorded units re-ran and verified in later sessions. Standing
  remainder: the ~4 unmetered episodes above, unrecoverable by design of
  the pre-fix failure path.
- `experiment-frame-limit-failure.jsonl` (+summary): superseded by
  recovery. The hud 0.6.12 64 KiB `readline` limit is worked around by
  `raise_hud_stream_limit()` in the driver; both verified rows carried
  forward by value, and the destroyed evolved trial-0 episode was re-paid
  and verified in run 3.
- `experiment-connection-failures.jsonl` (+summary): superseded by
  recovery. Its 13 verified rows replayed by cache into the final file;
  the five xarray connection casualties re-ran as fresh paid episodes
  (no errors recurred), and the astropy trial-1 evolved verifier blemish
  (half-written harness directory left by an audited operator error) was
  re-graded from its cached, delivery-complete, already-paid episode with
  no new inference.
- Standing, non-superseded: the run-1 unmetered spend gap and the
  operator-error audit recorded in NOTES.md (kill the process group, not
  the wrapper).

## Files

- `run_experiment.py`: two-arm driver: preregistration check, per-arm
  executors, frame-limit workaround, incremental fsynced evidence.
- `analyze_experiment.py`: report synthesis (pass/fail table, delivery
  checks, paired bounds, MDE, spend, receipts).
- `account_spend.py`: cross-session unique-payment accounting.
- `evidence/experiment.jsonl`: final complete 18-unit evidence.
- `evidence/experiment-report.json`: synthesized report.
- `evidence/cross-session-spend.json`: spend reconciliation.
- `evidence/experiment-*-failure*.{jsonl,json}`: preserved failure
  receipts from the three defective sessions.
- `evidence/live-work/`: gitignored working tree (episode caches,
  official-harness run directories, environments).
