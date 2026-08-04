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

## Flagged, not rewritten

[PR #30](https://github.com/nikhil-vytla/hatch/pull/30) deletes the
threshold/action/powered decision gate. Prose describing that procedure is
describing code that is going away, so it was left alone rather than polished:

- `docs/RESEARCH-PROCESS.md` lines 47-49, 63-64, 142-145, 178, 231
- `docs/MODEL.md` line 138
- `docs/PIPELINES.md` lines 63, 67, 108, 113 (the `threshold=0.1` snippet would
  raise `TypeError` after #30 merges)
- `docs/methods/evolving-intent.md` lines 235-236
- `research/swebench-screening-round2-20260803/README.md` line 21 and the
  `_summary.md` files for both screening rounds, which say "underpowered" and
  "no advance/reject claim"

One exception: `README.md` step 4 described the decision procedure inside a
description of what `report.py` does, so it was rewritten to the statistics that
survive rather than left to rot.
