# Standalone brief reference

Write a brief only when the user asks for a handoff artifact. Otherwise route
the content into an existing document per the destination table in SKILL.md.

## Sections, in order

Delete any section that would be empty. Never render an empty heading.

1. **Question.** The exact research question and the audience, in one or two
   sentences.
2. **Result.** The answer, stated as observed fact with its scope. At most 12
   content lines; detail belongs in later sections.
3. **Code map.** 3 to 7 entry points, one line each on why a collaborator
   starts there.
4. **Evidence and reproduction.** Where the evidence lives, the exact commands
   to rerun it in a fenced block, and the expected output.
5. **Learnings.** Interpretations, each labeled as interpretation and tied to
   the evidence above.
6. **Limits and rejected hypotheses.** What the evidence cannot support, and
   what was tried and disproved.
7. **Next experiment.** One falsifiable experiment with a pass and a fail
   outcome.

Validate before delivering, from the repository root:

```bash
python3 parallax/.cursor/skills/distill-research-learnings/scripts/validate_brief.py path/to/brief.md
```

## Worked example

Distilled from the Parallax design decision at commit `5f640aa`. The test
suite validates this example, so it always passes the validator.

````markdown
# Brief: is Evolving Intent the core of Parallax?

## Question
Should Parallax treat Evolving Intent as its core abstraction, or as one
synthesis strategy behind a general research model? Audience: a collaborator
deciding where the next perturbation strategy plugs in.

## Result
Parallax fixes a general vocabulary (task and environment specifications,
admission invariants, matched arms, sealed evaluator authority, estimands) in
`parallax/docs/MODEL.md`, and documents Evolving Intent as one strategy over
that model in `parallax/docs/methods/evolving-intent.md`. A new strategy adds
a method doc and its admission invariant; it does not touch the model. The
repository is documentation-only. No synthesis or experiment execution exists.

## Code map
- `parallax/README.md` states current capability and the open TODOs.
- `parallax/docs/MODEL.md` defines the vocabulary and the verifier-authority
  invariant every strategy must preserve.
- `parallax/docs/methods/evolving-intent.md` records the published method,
  interpretation policy, and evidence limits.
- `parallax/NOTES.md` holds the chronological decision trail.

## Evidence and reproduction
The separation landed in merge commit `7d3d35f`
([pull request](https://github.com/nikhil-vytla/hatch/pull/6)).

```
git log --oneline -- parallax/docs
rg -c "TODO" parallax/
```

Expected: three commits, newest `cb2e50e`, and TODO counts of 3 in
`README.md`, 2 in `docs/MODEL.md`, 1 in `docs/methods/evolving-intent.md`.

## Learnings
- Interpretation: keeping verifier authority and sealed information in the
  model, not the strategy, is what lets two strategies share matched arms.
- Interpretation: the TODO list in `README.md` is the real capability
  statement; the prose describes intent.

## Limits and rejected hypotheses
- The docs are a specification. No admission predicate has run, so nothing
  proves the invariants are checkable in practice.
- Rejected: treating checkpoint evolution as an Evolving Intent stage.
  `MODEL.md` records it as a separate strategy needing its own state machine.

## Next experiment
Implement the admission predicate for one GSM8K Evolving Intent item. Pass: a
matched pair is admitted and a variant with leaked sealed answers is rejected.
Fail: the predicate cannot distinguish them without verifier changes.
````
