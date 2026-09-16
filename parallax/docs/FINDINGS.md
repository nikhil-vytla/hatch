# Findings

Every Parallax run that spent money or compute, what it was asked, and what it
returned. Read this before opening a research folder. The folders hold the
chronology and the raw evidence; this page holds the answers.

One row here carries a real result. The live GSM8K run measured a 10.9-point
accuracy penalty for presenting a task through an evolving intent trajectory, and
then split it: 8.6 points come from spreading the request over turns at all, and
only 2.3 from the intent changing, the second interval spanning zero. That
decomposition is the most substantive thing Parallax has produced, and only a
three-arm design could produce it.

The rest is groundwork and one retraction. We know which SWE-bench instances Claude
Opus 4.8 sits at a boundary on. The SWE-bench contrast returned an interval
spanning the entire estimand. The first checkpoint-evolution run returned a
separation that the second run traced to our own byte cap, so read those two rows
as a pair. Keeping the overturned row is the point of the page.

## Runs to date

| Run | Question | Answer | Spend | Evidence |
|---|---|---|---|---|
| Screening round 1, 2026-08-02 | Do any of the first 5 published SWE-bench IDs sit at a pass-rate boundary for Opus 4.8 under static single-turn prompting? | No. Two ceilings, three floors, no boundary. | \$0.518250 metered, at most \$0.541029 all-in | [`swebench-screening-run-20260802/`](../research/swebench-screening-run-20260802/README.md) |
| Screening round 2, 2026-08-03 | Same question over the rest of the medium-difficulty stratum, three trials each. | Three boundary instances at 2/3: astropy 14508, django 13786, xarray 4695. A Sonnet 4.6 tier-down found none. | \$2.972512 metered, no unmetered gap | [`swebench-screening-round2-20260803/`](../research/swebench-screening-round2-20260803/README.md) |
| Admission, 2026-08-03 | Do those three instances pass all six admission gates against the official harness? | Yes, all three, gold patch passing on the first attempt. | Docker compute only, no inference | [`swebench-experiment-prerequisites-20260803/`](../research/swebench-experiment-prerequisites-20260803/README.md) |
| Single vs evolved, 2026-08-03 | On those three instances, does a two-phase evolved prompt change the pass rate against a budget-matched single-turn prompt? | Unknown. Point estimate +0.111 for static, 95% interval [-1, 1]. Three source clusters cannot answer this. | \$1.219080 metered, plus \$0.31 to \$0.52 unmetered from a defective first session, so \$1.53 to \$1.74 all-in | [`swebench-single-vs-evolved-20260803/`](../research/swebench-single-vs-evolved-20260803/README.md) |
| Checkpoint-evolution screening, 2026-08-03 | With sealed suites, obligations, budgets, and model matched, does an agent extending its own workspace verify differently at stage 3 than one reopening from a frozen reference? | **Superseded by the row below.** The arms separated completely, evolved 0/10 verifiable at stage 3 against carry-reference 10/10 strict, but the failures were byte-cap overruns before any test ran. Read as an instrument artifact, not a result. | \$0.2813 metered | [`checkpoint-evolution-slice/screening-report.md`](../research/checkpoint-evolution-slice/screening-report.md) |
| Checkpoint-evolution disambiguation, 2026-08-03 | Was that separation self-accumulation, or was it our output ceiling? | The ceiling. Raise it and the separation vanishes: evolved strict 10/10 at every stage, paired bounds [0, 0] at stages 2 and 3, no verdict-level difference between the arms. What survives is a cost and bloat signature, evolved workspaces 2.3x carry's and 1.52x the spend. | \$0.2796 metered | [`disambiguation-report.md`](https://github.com/nikhil-vytla/hatch/blob/parallax-checkpoint-evolution/parallax/research/checkpoint-evolution-slice/disambiguation-report.md) ([#34](https://github.com/nikhil-vytla/hatch/pull/34)) |
| GSM8K live, three arms, 2026-08-03 | Does presenting a GSM8K task as an evolving intent trajectory change accuracy against a single fully-revealed turn, and if so, is the cause the evolution or the turns? | Mostly the turns. Evolved minus base is -0.109 [-0.160, -0.060], which splits into -0.086 for multi-turn presentation alone and -0.023 for evolution on top, the latter spanning zero. 144 sources, 1,296 episodes, zero run failures. | \$10.96 metered | [`gsm8k-evolving-intent-live-20260803/`](https://github.com/nikhil-vytla/hatch/blob/parallax-gsm8k-live/parallax/research/gsm8k-evolving-intent-live-20260803/README.md) ([#33](https://github.com/nikhil-vytla/hatch/pull/33)) |

Metered spend across the six paid runs is \$16.23, or \$16.54 to \$16.77 all-in
once the unmetered gaps are bounded. Admission spent Docker compute and no
inference. Every figure is re-derived from retained token counts at current
model-specific rates, not copied from a run's own receipts. See
[the spend audit](#the-spend-numbers-were-wrong-and-are-now-audited).

### The spend numbers were wrong and are now audited

Round 1 published \$1.669650. The true figure is \$0.518250, a third of that. The
runtime had priced Opus 4.8 through a retired Opus rate card and, worse, priced
the Haiku construction calls as Opus too, fifteenfold over. Every figure in the
table above is now token-derived at current model-specific rates.

| Run | Published | Audited |
|---|---|---|
| Screening round 1 | \$1.669650 | \$0.518250 metered, at most \$0.541029 all-in |
| Screening round 2 | \$2.972512 | \$2.972512, correct as published |
| Single vs evolved | \$1.219080 + \$0.40 to \$0.80 | \$1.219080 + \$0.31 to \$0.52 |
| Checkpoint evolution, both runs | \$0.56 | \$0.56 |

Round 2's figure survives audit for a specific reason worth copying: its summary
re-derives cost from retained token counts instead of summing its own receipts.
Sum those receipts and you get \$8.544627, because the receipts were written at
stale rates and never revisited. Round 1 summed receipts and was wrong by 3x. Do
not trust a cost that a run computed about itself at write time.

The single-vs-evolved metered figure is the one I trust most in the table: two
independent derivations agree to the cent. Its unmetered band moved down because
the old \$0.40 to \$0.80 was itself extrapolated from the retired rates.

### What the screening rounds actually bought

Twenty-four Opus 4.8 instances were screened across both rounds, and the outcome
distribution is brutally bimodal: 9 ceilings, 12 floors, 3 instances at 2/3, and
not one at 1/3. Boundary instances are rare enough that finding three cost \$3.49
and two rounds of design revision. That is the real constraint on every paired
experiment that follows, because a paired design needs boundary instances and
there are only three of them.

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

Two things surprised me. The evolved condition cost about 5 percent less than
static, not twice as much, so the preregistered 2x evolved multiplier was wrong by
roughly a factor of two in the safe direction. Both arms ran the same model, so
that ratio holds regardless of which rate card priced it. And xarray 4695 screened
at 2/3 then went 0/6 in
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

### Most of the evolving-intent penalty on GSM8K is just multi-turn

This is the run to read. 144 GSM8K sources, three arms, three trials, Claude Haiku
4.5 through the HUD gateway. 1,296 graded episodes, zero run failures, \$10.96.

| Arm | Accuracy | 95% CI |
|---|---|---|
| base, 1 turn | 0.720 | [0.648, 0.789] |
| matched, ~8.6 turns | 0.634 | [0.563, 0.704] |
| evolved, ~8.6 turns | 0.611 | [0.539, 0.683] |

The primary contrast, evolved minus base, is -0.109 with a 95% source-clustered
bootstrap interval of [-0.160, -0.060]. Presenting the same verifiable task as an
evolving trajectory instead of one fully-revealed turn costs Haiku 4.5 about 11
accuracy points. Zero run failures means the identification bounds sit exactly on
the point estimates, so nothing here depends on how missing outcomes were handled.

Then the part that matters. Because the matched arm ran, that gap decomposes:

| Component | Estimate | 95% bootstrap |
|---|---|---|
| Multi-turn presentation alone (matched minus base) | -0.086 | [-0.130, -0.044] |
| Intent evolution on top (evolved minus matched) | -0.023 | [-0.081, +0.035] |

Four fifths of the penalty is the cost of spreading the request across turns. The
matched arm never changes the goal and never corrects a value; it reveals the same
source intent one argument at a time, and that alone costs 8.6 points. What is left
for the intent actually evolving is 2.3 points on an interval that spans zero.

A two-arm design would have reported the full 10.9 points as an evolving-intent
penalty. That number would have been correct and the mechanism attributed to it
would have been wrong. This is the single strongest argument in the repo for
keeping a turn-matched control, and it is worth reading against the SWE-bench
experiment above, which has no matched arm and therefore could not have caught
this.

Two caveats travel with the result. First, going live exposed three defects that
were invisible offline and would each have silently invalidated the run. The worst:
nothing ever told the agent about the `FINAL_ANSWER:` output contract the grader
requires. Haiku answered in Markdown prose, so every episode in every arm would
have graded invalid and the experiment would have measured prompt formatting.
Scripted test agents satisfy contracts that real models never see. Second, the
trials are not replicates; see the caveat below, which applies to every row.

## Caveats that apply to every row

**Trial seeds do not do anything.** The HUD gateway accepts an OpenAI-style `seed`
parameter and silently ignores it. This was measured, not assumed: same seed,
different completions. Every run on this page records trial seeds in its evidence,
and none of those seeds makes a trial reproducible. Trials are temperature-1.0
samples from the same distribution, which is fine for clustered intervals and
useless for exact replay. Do not read a recorded seed as a promise that rerunning
reproduces the row.

## Gaps this index makes obvious

- GSM8K is the only flow with both a complete design and real-model evidence at a
  resolving scale, and it is also the easiest benchmark here. SWE-bench has real
  Opus episodes, three source clusters, and no matched arm. Checkpoint evolution
  has two paid runs on the same single family.
- Three source clusters will never clear a meaningful interval on SWE-bench.
  Either the boundary pool grows or the estimand changes.
- Checkpoint evolution needs more than one family before any contrast it produces
  is worth interpreting. The byte-budget question is settled and gated in code;
  the sample size is not.
- The decomposition that makes the GSM8K result worth having came from the matched
  arm, and no other flow has one. Whether the 8.6-point multi-turn cost transfers
  to a harder benchmark is unmeasured.
- Cap schedules, reply formats, and output contracts are design parameters. Two
  runs on this page were derailed by treating one of them as a default.

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
