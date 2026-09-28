# Notes: prose audit

Goal: strip AI writing patterns and ceremony from every markdown file under
`parallax/`, then fix the structural problems that the word-level pass exposed.

## Census before

- 396 em dashes across 31 of 45 markdown files. Worst offenders:
  `research/admission-qc/README.md` (40), `research/spec-translation/README.md`
  (38), `research/admission-qc/NOTES.md` (27),
  `research/checkpoint-evolution-slice/NOTES.md` (27).
- 5 AI-vocabulary hits, all "additionally". Low, which was a pleasant surprise.
- No emoji, no curly quotes, no "not just X but Y". Whoever wrote this was
  already avoiding the obvious tells and losing to the subtle ones.

## Method

Hand-editing 396 dashes was not going to happen, and a blind `s/—/,/g` produces
comma splices everywhere. So: [`remove_em_dashes.py`](remove_em_dashes.py) with
context rules (heading and code-lead forms become colons; a following
independent-clause starter becomes a period), then read the full diff and repair
what the rules got wrong with [`repair_splices.py`](repair_splices.py). The
repair pass ended up covering about 90 sites, roughly a quarter of the total,
which is about the hit rate I would expect from a rule set this crude.

The lesson for anyone repeating this: the script is not the work. The diff review
is the work. The script just makes the diff small enough to read.

## Incidents

- The mechanical pass produced `(deterministic. No retry needed)` and a
  line-leading `, so the skill's triage`, which is what happens when you apply
  sentence rules to a parenthetical and to a wrapped continuation line. Both
  caught by grepping for the shapes rather than by reading.
- Money and math collide. `(\$0.1721 vs \$0.1092)` renders as LaTeX on GitHub,
  because both delimiters satisfy the inline-math rule. Escaped every `$`
  followed by a digit across 23 files, after checking that no math span in the
  repo opens with a digit and that no fenced code block was touched.
- One `\(...\)` LaTeX delimiter had survived PR #26's math conversion, in
  `research/admission-qc/NOTES.md`. Converted to `$...$`.
  [`check_markdown.py`](check_markdown.py) now fails on that pattern so it
  cannot come back.
- `src/parallax/delivery.py:19` contains an em dash inside the upstream intent
  update prompt ("Hold on — before you finalize…"). Left alone. That string is
  reproduced verbatim from the reference implementation, and changing it changes
  what the agent sees.

## Unbacked claims found

Four READMEs certified mutation-testing results with no committed gauntlet: a
"core suite" at 28/28 and a "Slice 2 suite" at 36/36, 44/44, 48/48, or 49/49
depending on which folder you read. The drifting denominator is the tell. Only
two gauntlets exist in the tree:
`swebench-experiment-prerequisites-20260803/mutation_gate.py` (6 mutants) and
`checkpoint-evolution-slice/mutants/run_gauntlet.py` (24). Marked the rest
unreproducible in the READMEs and left the session counts in the NOTES files,
where they read as a record rather than a certification.

## Stale text found

- `docs/methods/checkpoint-evolution.md` claimed "no real-model evidence exists"
  after the \$0.28 Haiku screening had already run.
- `docs/PIPELINES.md` described checkpoint evolution as unmerged and in flux,
  with a "no report module or paid run" bullet.
- `docs/RESEARCH-PROCESS.md` listed real-model evidence, non-GSM8K benchmarks,
  and checkpoint evolution as out of scope. All three had landed.
- `research/README.md` listed 7 of 9 research folders.
- `docs/MODEL.md` had a sentence that stopped mid-thought around line 138, and
  claimed the gold patch is discarded at ingestion when it is retained for
  admission gate G4.
- `research/upstream-design-audit/_summary.md` still recommended fixing the
  `advance()` tool that had already been deleted.

## Decision-gate prose: flagged, then deleted

The first pass left the threshold/action/powered decision-gate prose alone,
because [PR #30](https://github.com/nikhil-vytla/hatch/pull/30) was open and
about to delete the code underneath it. Polishing a description of code that is
being removed is wasted work. #30 merged, so the second pass deleted it.

#30 had already handled the `docs/` copies as part of its own change: the
`advance`/`reject`/`inconclusive` rule in `RESEARCH-PROCESS.md`, the manifest
threshold in `MODEL.md`, the `threshold=0.1` snippet and `report["action"]` print
in `PIPELINES.md`, and the `underpowered` sentence in `evolving-intent.md`. Those
came through the merge as #30's facts with my sentence shapes layered back on
top.

What was left for me was `research/`, where five documents still reported a
verdict:

- `swebench-screening-run-20260802/` README, NOTES, and `_summary.md`
- `swebench-screening-round2-20260803/` README, NOTES, and `_summary.md`
- `swebench-single-vs-evolved-20260803/` README, NOTES, and `_summary.md`

The rule applied: an interval and a minimum detectable effect are measurements
and stay. "Underpowered", "no advance/reject decision", and "the +/-0.2 decision
threshold" name a procedure that no longer exists, so they go. Where deleting the
verdict left a sentence with no point, the numbers say the same thing more
directly: MDE 1.568 against an estimand bounded in [-1, 1] already tells you the
design resolves nothing, and it does so without inventing a gate to fail.

`parallax/NOTES.md` is the one place the old procedure still appears, and
deliberately. #30 appended a "Power gate removed" entry that reverses an earlier
entry by name. Deleting the earlier entry would leave the reversal pointing at
nothing. A chronology that records a mistake and its correction is doing its job.

Two verdicts that look similar and survive: the `admit`/`admit-with-notes`/
`reject` outcome of task admission review, and the CE preregistration's
proceed-or-fix-first rule, which keys on evidence completeness rather than on any
statistic.
