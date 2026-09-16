# Single-vs-evolved experiment notes

## Scope

This unit executes the preregistered 18-unit single-vs-evolved experiment:
3 admitted boundary instances (`astropy__astropy-14508`,
`django__django-13786`, `pydata__xarray-4695`) x 2 conditions
(static single-turn vs evolved harness-delivered two-phase) x 3 paired
trials, Claude Opus 4.8 through the HUD gateway, official SWE-bench
harness grading in local Docker under `linux/amd64`.

The design was preregistered at
`../swebench-experiment-prerequisites-20260803/evidence/single-vs-evolved-design.json`
with design digest
`e230043ce85483b90e636b594e828dd78f525ddd9fd4bc6a25bf11caeeda4eaa`.
No experiment unit had run before this unit.

## Execution rules

- All 18 preregistered units run to completion. The user approved spend
  beyond the $3.50 preregistration cap; the run only stops for cost if
  spend tracks beyond ~$25 (a defect indicator), or on auth failure.
- Evidence is incremental and fsynced per unit through the existing
  `run_screening` partial-file machinery.
- Every graded unit carries an official-harness receipt (report digest,
  harness revision, image digest).
- Every evolved episode must carry a complete per-phase delivery receipt
  proving the harness delivered both scripted phases.

## Work log

- 2026-08-03: Read the prerequisites unit (harness-owned delivery, G1-G6
  admission, preregistered design) and round-2 screening scripts. Confirmed
  Docker Desktop is running, the pinned Verified parquet at
  `/tmp/swebench-verified-91aa3ed.parquet` matches digest `43ed5a3d...`, and
  the pinned harness clone from round 2 is at
  `f7bbbb2ccdf479001d6467c9e34af59e44a840f9`.
- 2026-08-03: Found that `HudExecutor` caches episodes at
  `episodes/<instance>/trial-<index>.json` and grades under
  `official-harness/<source>/trial-<index>` without the arm in either path.
  A single executor over a two-arm plan would reuse static episodes for
  evolved units. The driver therefore builds one executor per arm with
  separate work directories (`live-work/static`, `live-work/evolved`) and
  dispatches on `unit.arm`. Library code is unchanged.
- 2026-08-03: The driver reconstructs the three script families from the
  round-2 construction receipts (seed 20260803, 12 total steps, 4096 output
  tokens), revalidates them against the committed admission records through
  `AdmittedSweFamily`, builds the two-arm plan with
  `build_admitted_screening_plan`, and refuses to run unless the plan's
  18 units match the preregistered design manifest exactly (source, trial
  index, trial seed, arm, model).
- 2026-08-03: Pinned harness source is shared into each arm work directory
  by symlink; `run_official_harness` re-verifies its revision per grading
  run.
- 2026-08-03: No-spend smoke test passed. The two-arm plan has exactly the
  18 preregistered units; screening design digest
  `175dc9521d461fb24b93ef932955976d007a9d5f34724b7ad7e7516b46f3184b` is
  linked to preregistered digest `e230043c...` in
  `evidence/preregistration-linkage.json`. Episode cost band $0.10-$0.30
  gives a $1.80-$5.40 plan estimate under the $25 defect-stop cap.
- 2026-08-03: Launched the paid run. HUD_API_KEY was exported into the
  process environment only (never printed, logged, or written to evidence).
- 2026-08-03: DEFECT. The first four units all failed with "HUD run omitted
  a complete delivery receipt" while still spending inference. Stopped the
  run after three recorded units (the fourth was killed mid-episode). Root
  cause: the environment returns the delivery receipt through HUD grade
  info as JSON, so tuple fields arrive as lists; the client parsed it with
  strict python-mode `model_validate`, which rejects list-for-tuple. This
  was the first live exercise of the harness-delivery path (the
  prerequisites unit ran no inference), and no test covered the wire-shaped
  parse. Reproduced the failure offline with a round-tripped receipt.
- 2026-08-03: Fixed `hud_screening.py`: `parse_delivery_receipt` validates
  through JSON mode, and episode-level failures now retain the episode's
  metered usage instead of reporting zero spend (the old path raised before
  collecting token counts, which is why the three recorded failures carry
  $0 while roughly four episodes of real Opus spend went unmetered,
  ~$0.40-0.80 by round-2 averages). Added two regression tests; 138 tests,
  Ruff, format, and `ty` all pass.
- 2026-08-03: Preserved the failed attempt as
  `evidence/experiment-delivery-wire-failure.jsonl` with a summary, per the
  round-2 failure-evidence convention. Relaunching all 18 units fresh.
- 2026-08-03: SECOND DEFECT. On the relaunch, astropy static trial-0
  verified cleanly (wrong, $0.128 metered), but the paired evolved unit
  failed with "[cleanup] Separator is found, but chunk is longer than
  limit" after $0.046 of metered spend (the usage-preserving fix captured
  it). Root cause in the pinned hud 0.6.12 SDK: control-channel frames are
  newline-delimited JSON read by `StreamReader.readline()` on
  `asyncio.open_connection` defaults, so any frame over 64 KiB (a long
  shell tool result, or the grade frame that embeds the entire candidate
  patch) raises `LimitOverrunError` and destroys the episode after the
  money is spent. hud's rollout wrapper labels it "[cleanup]" because its
  `finally` reassigns the phase before the exception is reported. Left
  unfixed this would systematically bias against whichever condition
  produces longer tool output or bigger patches.
- 2026-08-03: Stopped the run, preserved the partial as
  `evidence/experiment-frame-limit-failure.jsonl` with a summary, and
  added `raise_hud_stream_limit()` to the driver: `asyncio.open_connection`
  now defaults to a 16 MiB stream limit before any episode. This is a
  driver-level operational workaround for the pinned SDK, not library code.
  The kill also interrupted the official grading of static trial-1; its
  incomplete harness directory was deleted (grading is compute-only and
  reruns free), while both completed static episode caches are reused by
  the relaunch, so no inference is repeated.
- 2026-08-03: OPERATOR ERROR, audited. Killing the run-2 shell wrapper did
  not kill its python child. The orphan kept working for ~4 minutes: it
  finished grading static trial-1 (pass, appended to the pre-rename
  partial, hence 4 lines in `experiment-frame-limit-failure.jsonl`), ran
  the evolved trial-1 episode ($0.080445 metered, episode cached), and
  started grading it. Removing what I believed was a stale grading
  container actually killed the orphan's live evolved-trial-1 grading; the
  orphan died at 16:26:10Z without appending. Run 3 then reused the
  orphan's cached episode (no double payment, cost carried into the
  receipt) but found the half-written harness directory and recorded
  "incomplete previous official harness directory" as a verifier
  run_failure for astropy trial-1 evolved. Audit of both evidence files
  shows no duplicate rows and a single writer from 09:27 on. Lesson: kill
  the process group, not the wrapper.
- 2026-08-03: The full pass finalized `experiment.jsonl` with 18 recorded
  units at $0.985275 metered. Twelve units verified. Six were
  infrastructure failures, not model outcomes: the astropy trial-1 evolved
  dirty-directory blemish, plus five of six xarray units killed by HUD
  gateway connection errors after 1-3 steps ("[cleanup] Connection
  error."), which also explains the long wall clock (each stall burned its
  rollout timeout). One xarray unit (trial-1 evolved) verified in the same
  window, so the gateway was flaky rather than down.
- 2026-08-03 17:17: During an idle window the as-run file was preserved as
  `evidence/experiment-connection-failures.jsonl` with a summary recording
  the recovery procedure (re-execute failed units in a fresh complete
  evidence file per round-2 precedent; verified units replay from episode
  and report caches with no new inference), and the half-written astropy
  harness directory was removed. This session did not perform that rename;
  it matches the failure-evidence convention used twice above and is
  adopted as the recovery path.
- 2026-08-03 21:0x: Relaunched `run_experiment.py`. Replayed units carry
  their original metered cost into the fresh file, so cross-file spend
  accounting must count unique payments, not file sums. New inference is
  limited to the six previously failed units (astropy trial-1 evolved
  re-grades its cached episode with no inference).
- 2026-08-03 21:10: A recovery session found the relaunch already in
  flight (started 21:09, not sleep-protected) and adopted it instead of
  double-running: attached `caffeinate -dims -w <pid>` to the live python
  process so macOS sleep could not kill a third run, and monitored the
  stream. A `repair_units.py` draft of the abandoned supplementary-file
  approach was launched twice, failed fast without writing evidence, and
  was deleted before this run started; the fresh-complete-file path is the
  one that ran.
- 2026-08-03 21:18: Recovery run finalized `evidence/experiment.jsonl`:
  18/18 units verified, zero run failures. The astropy trial-1 evolved
  unit re-graded its cached paid episode (pass, $0.080445 carried, no new
  inference). The five xarray units ran fresh paid episodes with no
  recurrence of the gateway connection errors ($0.188335 total new
  inference). One benign `RuntimeError: Event loop is closed` traceback
  from httpx cleanup printed between units; it belongs to post-episode
  connection teardown after `asyncio.run` closes the loop and affected no
  unit.
- 2026-08-03 21:19: `analyze_experiment.py` wrote
  `evidence/experiment-report.json`. Every evolved episode carries a
  complete two-phase delivery receipt (6+6 steps, budget-exhaustion
  triggers); every static episode a single 12-step phase. All 18 units
  have official-harness receipts on pinned revision `f7bbbb2c...` and
  reported model `claude-opus-4-8`. Paired single-minus-evolved delta is
  +0.111 on 9/9 complete pairs with degenerate identification bounds
  [0.111, 0.111]; the source-clustered MDE is 1.568 (3 sources), so the
  95% interval is the trivial [-1, 1] and the report stays bounds-only.
- 2026-08-03 21:2x: `account_spend.py` wrote
  `evidence/cross-session-spend.json`: unique metered spend $1.219080
  (run 2 $0.349545 including the orphan's evolved trial-1 payment, run 3
  $0.681200, run 4 $0.188335), reconciled exactly against the final file
  sum plus the two destroyed-episode cost pools. Run 1's ~4 unmetered
  episodes (est. $0.40-0.80) remain a standing accounting gap.
- 2026-08-03 21:30: All 18 units verified. astropy trial-1 evolved
  re-graded to PASS from the cached episode; all five xarray retries
  verified (gateway healthy again). Final file totals $1.105265; unique
  metered spend across all attempts is $1.219080 (sum of fresh-episode
  receipts and metered failure receipts), plus an estimated $0.40-0.80
  unmetered from the run-1 defect. `account_spend.py` (added during the
  21:0x recovery session) independently attributes each payment to
  its paying session and reconstructs the same $1.21908 total;
  `evidence/cross-session-spend.json` is its output. Results: astropy static 2/3 vs evolved
  1/3; django 3/3 vs 3/3; xarray 0/3 vs 0/3. Paired single-minus-evolved
  point delta +0.111 with identification bounds [0.111, 0.111]; Hoeffding
  epsilon 1.568 over 3 source clusters, minimum detectable effect 1.57,
  underpowered, bounds-only. All 18 delivery receipts complete; all nine
  evolved episodes consumed 6+6 steps with budget_exhaustion then
  terminal_budget_exhaustion — the harness delivered the second turn in
  every evolved episode and no early submission ever skipped a phase.
- 2026-08-03 21:30: Surprise worth recording: the evolved condition cost
  less than static ($0.538 vs $0.567) — the preregistered 2x evolved
  multiplier was conservative by roughly 2x. And xarray sat at floor 0/6
  after screening at 2/3, a reminder that three-trial screening rates
  carry wide intervals.
- 2026-08-03 23:5x, cost correction: the $1.219080 metered total survives
  audit. This run's receipts were written after the retired-rate pricing
  constant was fixed, and re-metering every retained token count at the
  canonical rates reproduces $1.219080 exactly without consulting a single
  recorded dollar figure (`research/spend-audit-20260803/`). What was wrong is
  the run-1 unmetered band: $0.40-0.80 came from round-2 episode averages that
  were themselves priced at the retired Opus 4.1 rate card. Pricing the same
  astropy units at what they cost when re-run and metered gives $0.31-0.52, so
  the all-in figure is $1.53-1.74 rather than $1.62-2.02. `account_spend.py`
  now carries the corrected band and keeps the superseded one beside it.
