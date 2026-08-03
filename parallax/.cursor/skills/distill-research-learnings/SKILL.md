---
name: distill-research-learnings
description: Distills research code, evidence, and decisions into a concise explanation a colleague can understand, reproduce, and challenge. Use after an experiment, architecture review, benchmark adaptation, implementation slice, or bounded finding, or when the user mentions a research handoff, experiment results, benchmark findings, a collaborator summary, or distilling learnings.
---

# Distill research learnings

Turn a finished slice of research work into prose a colleague can understand,
reproduce, and challenge. Route the prose into an existing document whenever
one fits. A standalone brief is for explicit handoff requests, not the
default.

## Workflow

1. **Name the audience and the question.** One sentence each. Who reads this,
   and what exact research question does it answer. If the question is not
   falsifiable or the audience is "everyone", narrow both before writing.

2. **Gather direct evidence.** Read the real artifacts. The diff (`git log -p`,
   `git diff`), test output, run records, generated reports, the decision
   trail, and source links. Never trust an agent summary alone; agents report
   intent, not always outcome. Record file paths and commands as you read so
   step 8 is copy-paste.

3. **Sort every claim into one bucket.** Observed fact (you saw the artifact),
   interpretation (your reading of it), rejected hypothesis (tried and
   disproved, with the disproving evidence), limitation (what the evidence
   cannot support), or open question. Keep the labels visible in the output.
   Never blend interpretation into fact.

4. **Draw a code map.** 3 to 7 entry points, one line each on why a
   collaborator starts there. Fewer than 3 is too coarse to navigate. More
   than 7 duplicates the architecture docs.

5. **Pick the destination.** Default to an existing document, per the table
   below. When a canonical doc is the right home, edit it. Do not create a
   new learning document beside it.

6. **Keep versioned product docs timeless.** Product docs describe current
   state. Never write "this PR", "PR3", "later PR", or any delivery
   sequencing into them. Use current-state notes, warnings, and specific
   TODOs instead. Update or delete TODOs the work made stale; a TODO narrows
   or disappears as work lands.

7. **State claim limits next to each claim.** A green test proves only what
   it exercises. A model run does not prove causality. A deterministic
   artifact does not prove semantic validity. Write what the evidence
   supports and stop.

8. **Include exact reproduction.** The exact commands and expected outputs,
   where available. A reader who cannot rerun the check can only trust you.

9. **End with the next falsifiable experiment.** One concrete experiment with
   a pass and a fail outcome. Not a roadmap.

10. **Write plainly.** No hype, no chronology dump, no duplicated
    architecture narrative. If a section has no evidence, delete the section.
    Never render an empty heading.

## Destinations

| Content | Destination |
|---|---|
| Current capabilities and how to start | README |
| Chronological investigation details | NOTES |
| Theory and durable contracts | method docs, for example `parallax/docs/` |
| Change-specific rationale and tests | PR body |
| Handoff artifact the user asked for | standalone brief, see [reference.md](reference.md) |

## Validate

Run the commands below from the repository root. The validator takes an
explicit file path, so any working directory works if you adjust the paths.

Run the validator on any standalone brief before delivering it:

```bash
python3 parallax/.cursor/skills/distill-research-learnings/scripts/validate_brief.py path/to/brief.md
```

For a product doc you edited, check the timeless-language and empty-heading
rules only:

```bash
python3 parallax/.cursor/skills/distill-research-learnings/scripts/validate_brief.py --mode doc parallax/README.md
```

The validator encodes this skill's mechanical rules: required sections,
evidence with runnable commands, banned delivery-sequencing phrases, empty
headings, code map size, and length bounds. Fix every finding.

## Standalone brief

Section order, bounds, and a worked example distilled from the Parallax
design decision: [reference.md](reference.md).
