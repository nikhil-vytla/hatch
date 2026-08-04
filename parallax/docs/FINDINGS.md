# Findings

Every Parallax run that spent money or compute, what it was asked, and what it
returned. Read this before opening a research folder. The folders hold the
chronology and the raw evidence; this page holds the answers.

Six runs in, nothing here supports a claim about either synthesis method. We know
which SWE-bench instances Claude Opus 4.8 sits at a boundary on, and we know both
harnesses record what they say they record. Of the runs that measured a contrast,
one returned an interval spanning the entire estimand, one returned a separation
that turned out to be our own byte cap, and the third is the run that proved the
second wrong.

That retraction is on this page because that is what the page is for. The first
result this table ever carried was overturned by evidence within the hour, by a run
that changed one variable. Read the two checkpoint-evolution rows as a pair.

## Runs to date

| Run | Question | Answer | Spend | Evidence |
|---|---|---|---|---|
| Screening round 1, 2026-08-02 | Do any of the first 5 published SWE-bench IDs sit at a pass-rate boundary for Opus 4.8 under static single-turn prompting? | No. Two ceilings, three floors, no boundary. | \$1.67 metered (\$2.15 conservative all-in) | [`swebench-screening-run-20260802/`](../research/swebench-screening-run-20260802/README.md) |
| Screening round 2, 2026-08-03 | Same question over the rest of the medium-difficulty stratum, three trials each. | Three boundary instances at 2/3: astropy 14508, django 13786, xarray 4695. A Sonnet 4.6 tier-down found none. | \$2.97 metered | [`swebench-screening-round2-20260803/`](../research/swebench-screening-round2-20260803/README.md) |
| Admission, 2026-08-03 | Do those three instances pass all six admission gates against the official harness? | Yes, all three, gold patch passing on the first attempt. | Docker compute only, no inference | [`swebench-experiment-prerequisites-20260803/`](../research/swebench-experiment-prerequisites-20260803/README.md) |
| Single vs evolved, 2026-08-03 | On those three instances, does a two-phase evolved prompt change the pass rate against a budget-matched single-turn prompt? | Unknown. Point estimate +0.111 for static, 95% interval [-1, 1]. Three source clusters cannot answer this. | \$1.22 metered, plus \$0.40 to \$0.80 unmetered from a defective first session | [`swebench-single-vs-evolved-20260803/`](../research/swebench-single-vs-evolved-20260803/README.md) |
| Checkpoint-evolution screening, 2026-08-03 | With sealed suites, obligations, budgets, and model matched, does an agent extending its own workspace verify differently at stage 3 than one reopening from a frozen reference? | **Superseded by the row below.** The arms separated completely, evolved 0/10 verifiable at stage 3 against carry-reference 10/10 strict, but the failures were byte-cap overruns before any test ran. Read as an instrument artifact, not a result. | \$0.2813 metered | [`checkpoint-evolution-slice/screening-report.md`](../research/checkpoint-evolution-slice/screening-report.md) |
| Checkpoint-evolution disambiguation, 2026-08-03 | Was that separation self-accumulation, or was it our output ceiling? | The ceiling. Raise it and the separation vanishes: evolved strict 10/10 at every stage, paired bounds [0, 0] at stages 2 and 3, no verdict-level difference between the arms. What survives is a cost and bloat signature, evolved workspaces 2.3x carry's and 1.52x the spend. | \$0.2796 metered | [`disambiguation-report.md`](https://github.com/nikhil-vytla/hatch/blob/parallax-checkpoint-evolution/parallax/research/checkpoint-evolution-slice/disambiguation-report.md) ([#34](https://github.com/nikhil-vytla/hatch/pull/34)) |

Metered spend across the five paid runs is \$6.42. Admission spent Docker compute
and no inference.

### What the screening rounds actually bought

Twenty-four Opus 4.8 instances were screened across both rounds, and the outcome
distribution is brutally bimodal: 9 ceilings, 12 floors, 3 instances at 2/3, and
not one at 1/3. Boundary instances are rare enough that finding three cost \$4.64
and two rounds of design revision. That is the real constraint on every paired
experiment that follows, because a paired design needs boundary instances and
there are only three of them.

Round 2 also caught a pricing bug worth remembering: the runtime priced Opus 4.8
at the retired Opus 4.1 rate and priced Haiku construction as Opus. Reported
costs before that fix are wrong. The numbers in this table are recalculated from
retained token counts at current model-specific rates.

### What the single-vs-evolved experiment did and did not show

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

Two things surprised me. The evolved condition cost less than static (\$0.538 vs
\$0.567), so the preregistered 2x evolved multiplier was wrong by about a factor
of two in the safe direction. And xarray 4695 screened at 2/3 then went 0/6 in
the experiment, which is a useful reminder of how wide a three-trial pass-rate
estimate really is.

The experiment also has a design gap that the GSM8K design treats as mandatory:
it compared static against evolved with no turn-matched control arm. Conversation
length is not controlled for on SWE-bench. Any delta this design produced would
be unattributable even if it were significant.

### The checkpoint-evolution separation was our byte cap

The first run found the evolved arm failing 10/10 at stage 3 while
carry-reference passed 10/10 strict, and it was tempting to read that as an agent
degrading as it built on its own work. It was not. The failures were budget
overruns, 4802 to 4864 bytes against a declared 4096-byte cap, rejected before a
single sealed case ran. The evolved arm replies with a full file map, so it is the
only arm that has to re-emit everything it has accumulated inside the same cap
the lean arm enjoys.

The disambiguation run raised the ceiling and changed nothing else. The cap went
from flat 4096 to escalating 4096/8192/12288, and the output-token limit went from
2048 to 4096 so that a maximal legal reply could physically fit. Family specs,
sealed cases, references, contract, seeds, and model were byte-identical. The
obvious second lever, switching to delta-style replies, was deliberately left
alone: pulling two at once would have produced a difference nobody could
attribute.

| | First run, flat 4096 cap | Disambiguation, escalating caps |
|---|---|---|
| Stages 1 and 2, both arms | strict 20/20 | strict 20/20 |
| Stage 3, `carry-reference` | strict 10/10 | strict 10/10 |
| Stage 3, `evolved` | 0/10 verifiable, all budget failures | strict 10/10 |
| Stage 3 paired contrast | undecidable | observed 0, bounds [0, 0] |
| Spend | \$0.2813 | \$0.2796 |

One variable moved and the entire effect moved with it, so the effect was the
variable. There is no verdict-level difference between an agent extending its own
workspace and one reopening from a frozen reference, at this scale, once byte
pressure is off. The disambiguation run's 60 stage calls produced zero run
failures of any kind, all 60 validated.

What survives is a real measurement, just a smaller one than the first run
advertised. Accumulation shows up in size and in cost, not in correctness. On
identical schedules the evolved arm's workspaces run 2601 to 4851 bytes against a
uniform 2082 for carry-reference, roughly 2.3 times, and the evolved arm costs
1.52 times as much (\$0.1687 vs \$0.1108) because its own carried verbosity is
re-billed as input tokens at every stage. Note that the evolved stage-3 maximum,
4851 bytes, is itself above the original 4096 cap, which is the same fact from the
other direction. Whether bloat ever becomes a verification failure at a larger
scale is open; one family and one model cannot say.

The lesson is now enforced rather than described. `budget_headroom_violations` in
`src/parallax/checkpoint_evolution.py` refuses a family whose caps cannot cover
reference growth, requiring the stage-1 cap to cover twice the stage-1 reference
and every cap increment to cover twice the reference increment. The live screening
path raises `BudgetMatchingError` before any spend. Run against the original
family it rejects at stages 2 and 3, so it would have caught this confound before
the first dollar. Arms can be nominally budget-matched, on identical declared
caps, while being effectively unmatched, because the manipulation itself changes
how many bytes an arm must emit. Flat caps guarantee the evolved arm zero room for
new content.

Slice total across both runs: \$0.56 over 120 stage calls, 120/120 delivered and
validated, zero infrastructure failures.

## Gaps this index makes obvious

- No flow has both a complete design and real-model evidence at a scale that can
  resolve anything. GSM8K has all three arms and has never called a real
  provider. SWE-bench has real Opus episodes and no matched arm. Checkpoint
  evolution has two paid runs on the same single family.
- Three source clusters will never clear a meaningful interval on SWE-bench.
  Either the boundary pool grows or the estimand changes.
- Checkpoint evolution needs more than one family before any contrast it produces
  is worth interpreting. The byte-budget question is settled and gated in code;
  the sample size is not.
- Every measured contrast so far has been null or confounded, and the one that
  looked like a result was our instrument. Cap schedules and reply formats are
  design parameters and belong in a preregistration, not in a default.

## Adding a run

One row per run in the table above, in date order, with a link to the research
folder. If the run produced numbers that do not fit a table cell, add a
subsection under it. Keep the answer column an answer: if the run did not settle
its question, the cell says so and says why. A row that reads as a clean win when
the mechanism is unresolved is worse than no row.

When a later run overturns an earlier one, keep both rows. Mark the superseded row
and point it at its replacement rather than editing the original answer away. The
retraction is evidence about how the work is going, and a table that only shows
results which held up is not a record of anything.
