# Findings

Every Parallax run that spent money or compute, what it was asked, and what it
returned. Read this before opening a research folder. The folders hold the
chronology and the raw evidence; this page holds the answers.

Five runs in, nothing here supports a claim about either synthesis method. We
know which SWE-bench instances Claude Opus 4.8 sits at a boundary on, and we know
both harnesses record what they say they record. The two runs that measured a
contrast produced, respectively, an interval spanning the entire estimand and a
separation whose mechanism was our own reply format.

## Runs to date

| Run | Question | Answer | Spend | Evidence |
|---|---|---|---|---|
| Screening round 1, 2026-08-02 | Do any of the first 5 published SWE-bench IDs sit at a pass-rate boundary for Opus 4.8 under static single-turn prompting? | No. Two ceilings, three floors, no boundary. | \$1.67 metered (\$2.15 conservative all-in) | [`swebench-screening-run-20260802/`](../research/swebench-screening-run-20260802/README.md) |
| Screening round 2, 2026-08-03 | Same question over the rest of the medium-difficulty stratum, three trials each. | Three boundary instances at 2/3: astropy 14508, django 13786, xarray 4695. A Sonnet 4.6 tier-down found none. | \$2.97 metered | [`swebench-screening-round2-20260803/`](../research/swebench-screening-round2-20260803/README.md) |
| Admission, 2026-08-03 | Do those three instances pass all six admission gates against the official harness? | Yes, all three, gold patch passing on the first attempt. | Docker compute only, no inference | [`swebench-experiment-prerequisites-20260803/`](../research/swebench-experiment-prerequisites-20260803/README.md) |
| Single vs evolved, 2026-08-03 | On those three instances, does a two-phase evolved prompt change the pass rate against a budget-matched single-turn prompt? | Unknown. Point estimate +0.111 for static, 95% interval [-1, 1]. Three source clusters cannot answer this. | \$1.22 metered, plus \$0.40 to \$0.80 unmetered from a defective first session | [`swebench-single-vs-evolved-20260803/`](../research/swebench-single-vs-evolved-20260803/README.md) |
| Checkpoint-evolution screening, 2026-08-03 | With sealed suites, obligations, budgets, and model matched, does an agent extending its own workspace verify differently at stage 3 than one reopening from a frozen reference? | The arms separated completely, but not on the verifier. Evolved failed 10/10 seeds by overrunning the byte cap before any test ran; carry-reference passed 10/10 strict. Mechanism unresolved. A follow-up run is in flight. | \$0.28 metered | [`checkpoint-evolution-slice/screening-report.md`](../research/checkpoint-evolution-slice/screening-report.md) |

Metered spend across the four paid runs is \$6.14. Admission spent Docker compute
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

### What the checkpoint-evolution screening measured, and what it does not license

Sixty stage calls, ten trial seeds, two arms, three checkpoints, Claude Haiku
4.5, every sealed case executed inside a digest-pinned container. All 60 calls
delivered and validated, workspace-digest chain confirmed on all 60, zero
infrastructure failures. As harness validation this run is clean.

| Arm | Stage 1 | Stage 2 | Stage 3 |
|---|---|---|---|
| `evolved` (10 seeds) | strict | strict | budget RunFailure, 10/10 |
| `carry-reference` (10 seeds) | strict | strict | strict, 10/10 |

The separation at stage 3 is total, and it happened one level above the verifier.
The evolved arm replies with a full file map, so at each stage it re-serializes
everything it has accumulated. Its stage-3 replies came in at 4802 to 4864 bytes
against the family's declared 4096-byte cap, 17 to 19 percent over, and the
runner rejected them as budget failures before a single sealed case ran. The
carry-reference arm reopens each stage from the lean reference workspace and
answered stage 3 in 2077 bytes.

So what got measured is that carried verbosity crosses a byte cap. That is not
the verification decay the method is about, and it is not evidence for it. There
is no verdict-level contrast at stage 3 at all, in either direction, because zero
evolved stage-3 workspaces ever reached the verifier. Both the cap and the
full-file-map reply format are our design choices, not properties of checkpoint
evolution, and a looser cap or a diff-style reply could erase the separation
entirely. One family is one cluster, one model, one budget setting.

The honest version of the finding is narrower and still worth having: an agent
carrying its own artifact forward pays for it in output size, and it pays in
input tokens too. The evolved arm cost 1.6 times the carry arm on an identical
schedule (\$0.1721 vs \$0.1092), because its own accumulated verbosity comes back
as billed input. Whether that cost ever becomes a verification failure is exactly
what this run could not tell us.

A follow-up run is in flight to separate the two explanations by varying the cap
and the reply format. When it lands, update the row above and replace this
subsection with what it settled.

## Gaps this index makes obvious

- No flow has both a complete design and real-model evidence at a scale that can
  resolve anything. GSM8K has all three arms and has never called a real
  provider. SWE-bench has real Opus episodes and no matched arm. Checkpoint
  evolution has a real paid run on one family.
- Three source clusters will never clear a meaningful interval on SWE-bench.
  Either the boundary pool grows or the estimand changes.
- Checkpoint evolution needs more than one family before any contrast it produces
  is worth interpreting, and it needs the byte-budget question settled first.

## Adding a run

One row per run in the table above, in date order, with a link to the research
folder. If the run produced numbers that do not fit a table cell, add a
subsection under it. Keep the answer column an answer: if the run did not settle
its question, the cell says so and says why. A row that reads as a clean win when
the mechanism is unresolved is worse than no row.
