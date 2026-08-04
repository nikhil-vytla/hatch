# Findings

Every Parallax run that spent money or compute, what it was asked, and what it
returned. Read this before opening a research folder. The folders hold the
chronology and the raw evidence; this page holds the answers.

Nothing here supports a claim about intent evolution yet. Four runs in, we know
which SWE-bench instances Claude Opus 4.8 sits at a boundary on, and we know the
harness records what it says it records. The one experiment that measured an
effect produced an interval spanning the entire range of the estimand.

## Runs to date

| Run | Question | Answer | Spend | Evidence |
|---|---|---|---|---|
| Screening round 1, 2026-08-02 | Do any of the first 5 published SWE-bench IDs sit at a pass-rate boundary for Opus 4.8 under static single-turn prompting? | No. Two ceilings, three floors, no boundary. | $1.67 metered ($2.15 conservative all-in) | [`swebench-screening-run-20260802/`](../research/swebench-screening-run-20260802/README.md) |
| Screening round 2, 2026-08-03 | Same question over the rest of the medium-difficulty stratum, three trials each. | Three boundary instances at 2/3: astropy 14508, django 13786, xarray 4695. A Sonnet 4.6 tier-down found none. | $2.97 metered | [`swebench-screening-round2-20260803/`](../research/swebench-screening-round2-20260803/README.md) |
| Admission, 2026-08-03 | Do those three instances pass all six admission gates against the official harness? | Yes, all three, gold patch passing on the first attempt. | Docker compute only, no inference | [`swebench-experiment-prerequisites-20260803/`](../research/swebench-experiment-prerequisites-20260803/README.md) |
| Single vs evolved, 2026-08-03 | On those three instances, does a two-phase evolved prompt change the pass rate against a budget-matched single-turn prompt? | Unknown. Point estimate +0.111 for static, 95% interval [-1, 1]. Three source clusters cannot answer this. | $1.22 metered, plus $0.40 to $0.80 unmetered from a defective first session | [`swebench-single-vs-evolved-20260803/`](../research/swebench-single-vs-evolved-20260803/README.md) |

Metered spend across all four runs is $5.86.

### What the screening rounds actually bought

Twenty-four Opus 4.8 instances were screened across both rounds, and the outcome
distribution is brutally bimodal: 9 ceilings, 12 floors, 3 instances at 2/3, and
not one at 1/3. Boundary instances are rare enough that finding three cost $4.64
and two rounds of design revision. That is the real constraint on every paired
experiment that follows, because a paired design needs boundary instances and
there are only three of them.

Round 2 also caught a pricing bug worth remembering: the runtime priced Opus 4.8
at the retired Opus 4.1 rate and priced Haiku construction as Opus. Reported
costs before that fix are wrong. The numbers in this table are recalculated from
retained token counts at current model-specific rates.

### What the experiment did and did not show

Per-instance outcomes, static against evolved, three paired trials each:

| Instance | static | evolved |
|---|---|---|
| astropy__astropy-14508 | 2/3 | 1/3 |
| django__django-13786 | 3/3 | 3/3 |
| pydata__xarray-4695 | 0/3 | 0/3 |

All 18 units were graded by the pinned official SWE-bench harness, and every
evolved episode carries a complete two-phase delivery receipt, so the
intervention demonstrably reached the agent. The paired single-minus-evolved
delta is +0.111 with degenerate identification bounds, and the source-clustered
minimum detectable effect at three clusters is 1.568 against an estimand bounded
in [-1, 1]. The design cannot detect anything. Reporting the point estimate
without that number would be dishonest.

Two things surprised me. The evolved condition cost less than static ($0.538 vs
$0.567), so the preregistered 2x evolved multiplier was wrong by about a factor
of two in the safe direction. And xarray 4695 screened at 2/3 then went 0/6 in
the experiment, which is a useful reminder of how wide a three-trial pass-rate
estimate really is.

The experiment also has a design gap that the GSM8K design treats as mandatory:
it compared static against evolved with no turn-matched control arm. Conversation
length is not controlled for on SWE-bench. Any delta this design produced would
be unattributable even if it were significant.

## Gaps this index makes obvious

- No flow has both a complete design and real-model evidence. GSM8K has all
  three arms and has never called a real provider. SWE-bench has real Opus
  episodes and no matched arm.
- Three source clusters will never clear the power gate. Either the boundary
  pool grows or the estimand changes.
- Checkpoint evolution has code in flight on
  [PR #27](https://github.com/nikhil-vytla/hatch/pull/27) and no paid run.

## Adding a run

One row per run in the table above, in date order, with a link to the research
folder. If the run produced numbers that do not fit a table cell, add a
subsection under it. Keep the answer column an answer: if the run did not settle
its question, the cell says so and says why.
