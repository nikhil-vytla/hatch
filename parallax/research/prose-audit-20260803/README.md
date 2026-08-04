# Prose audit

An unslop pass over all 45 markdown files under `parallax/`, plus the structural
fixes the pass exposed. Chronology and incidents in [NOTES.md](NOTES.md).

## What changed

The big one is [`docs/FINDINGS.md`](../../docs/FINDINGS.md), which did not exist.
Answering "what has this project learned" previously meant opening a dated folder
and reading a chronology. It is now one table: every run that spent money, what
it was asked, what came back, the cost, and a link to the evidence.

Word level, across 45 files: 396 em dashes removed, 5 AI-vocabulary hits cut,
inline-header lists that only restated their own labels turned into prose, and
sentence-case headings throughout. Every `$` followed by a digit is now escaped,
because GitHub renders `(\$0.1721 vs \$0.1092)` as math.

Structurally: four unbacked mutation-testing certifications marked
unreproducible, six stale claims corrected, one collapsed NOTES/README trio, and
one surviving `\(...\)` LaTeX delimiter converted.

After [PR #30](https://github.com/nikhil-vytla/hatch/pull/30) merged, the
decision-gate prose this pass had flagged rather than rewritten was deleted.
Intervals and minimum detectable effects stayed as measurements. The
`underpowered` and `advance/reject` verdicts computed against them went, since
the code that computed them is gone. `parallax/NOTES.md` keeps its record of
building the gate, because #30 appended the entry that reverses it.

## Tools

- [`check_markdown.py`](check_markdown.py) walks a directory and fails on broken
  relative links, missing heading anchors, `\(...\)` or `\[...\]` LaTeX
  delimiters outside code spans, and unbalanced code fences. Run it before any
  docs PR:

```bash
python3 parallax/research/prose-audit-20260803/check_markdown.py parallax
```

- [`remove_em_dashes.py`](remove_em_dashes.py) and
  [`repair_splices.py`](repair_splices.py) are the one-shot scripts that did the
  bulk pass, kept as the record of how it was done. The dash script is reusable;
  the repair script is a hardcoded list of this pass's specific fixes.

## What this pass could not fix

Two gaps in the docs are gaps in the work, and no amount of rewriting closes
them.

First, no flow has both a complete design and evidence at a scale that can
resolve anything. GSM8K has all three arms and has never called a real provider.
SWE-bench has real Opus episodes and no matched control arm. Checkpoint evolution
has a real paid run on exactly one task family. Writing this down honestly in
`FINDINGS.md` made it much harder to look at than it was when it was distributed
across four folders.

Second, the checkpoint-evolution screening result reads as a clean arm separation
and is not one. The evolved arm failed 10/10 on a byte cap we chose, under a reply
format we chose, before any test ran. That needs a variant run, not better prose.

## Suggested follow-up

- Commit gauntlets. Four READMEs certified mutation kill rates from scripts that
  were run in-session and thrown away, and the reported denominator drifts
  between folders. A number nobody can re-derive is decoration.
- Wire `check_markdown.py` into CI. The `\(...\)` delimiter that survived PR #26
  would have been caught for free.
