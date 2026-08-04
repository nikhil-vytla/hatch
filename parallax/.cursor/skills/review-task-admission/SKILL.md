---
name: review-task-admission
description: Judgment-side review of generated Parallax task families — the half of admission QC that mechanical gates cannot decide. Use when a new task family has been generated, when triaging admission-gate failures or rejected sources, when spot-checking an admitted population before an experiment, or when the user mentions task quality review, rendered-turn review, ambiguity or naturalness of generated tasks, or admission verdicts.
---

# Review task admission

Mechanical admission gates (schema, sealed-leakage lint, no-op, gold,
budget matching, arm completeness) decide everything an executable check
can decide. This skill covers the rest: the properties that can only be
wrong in a way a reviewer argues about. Ambiguity, naturalness,
paraphrase-level leakage, cheap paths through the task, and what a gate
failure actually means.

This is a judgment exercise, not a form. A review that finds nothing wrong
is three sentences and a verdict, not a filled-out checklist. Spend your
attention where the generated material is weird, not on confirming the
obvious.

## When to invoke

- **New task family generated.** Review a sample before anyone runs
  experiments on it. Sample small (3–5 families); if those are clean, the
  generator is probably clean — if not, widen.
- **Gate-failure triage.** An admission record shows rejections and someone
  needs to decide: fix the task, fix the pipeline, or accept the loss.
- **Pre-experiment spot check.** An admitted population is about to be
  scheduled; sanity-check a couple of sources per arm against the questions
  below.

## What to look at

Read what the agent will read, in the order it will read it: the rendered
public turns (`PublicScriptV1.turns` per arm) or the compiled agent
artifacts (`CompiledBundleV1.agent_artifacts`), one arm at a time. Do not
start from internal state — intents, event schedules, construction
transcripts — because the agent never sees those, and reviewing them
first anchors you on what the generator *meant* instead of what it *said*.
This is METR's QA independence rule applied to an agent reviewer: the QA
runner sees only what the subject sees.

Consult sealed authority (test patches, F2P lists, gold answers) only
after forming an impression, and only to adjudicate a suspected leak or a
gate failure. Never quote sealed material into your verdict.

## The five questions

Ask these of each arm's rendered turns. They are prompts for judgment,
with the heuristic that makes each one operational. Skip any question that
obviously doesn't apply; note anything load-bearing you observed even if
no question names it.

**1. Could two correct agents read this differently?**
The ambiguity test (slop-code-bench's "could two correct implementations
produce different outputs?"; Anthropic's "two domain experts would grade
identically"). For each turn that states a requirement, ask whether a
competent reader could satisfy it in a way the sealed verifier rejects.
Caution against *false* ambiguity: deliberate under-specification is
correct design — a turn need not pin exact error strings or internal
architecture. Flag only ambiguity that changes whether the verifier
passes.

**2. Would a real user say this?**
The naturalness test (METR: not "weird or confusing in a way that might
unfairly throw the agent off"; not difficult for incidental reasons). Read
the evolved arm's turn sequence as a conversation: does it read like a
person revealing, revising, and changing their mind — or like a template
with slots filled? Templated phrasing is acceptable if it is *coherent*;
flag turns that are contradictory, refer to context that doesn't exist,
or bury the actual requirement under scaffolding language. At family
level, apply HUD's same-shape diagnostic: if every family is the same
sentence with different nouns, the population tests one thing, not many.

**3. Does anything public hint at what is sealed?**
The lint (gate G2) catches verbatim bytes. You are looking for what it
cannot catch (HUD's taxonomy): root-cause leakage (prose that names the
fix or the buggy function), grader leakage (vocabulary that exists only to
satisfy the verifier), and eval-context leakage (text implying this is a
test, an experiment, or a scripted exercise — it changes agent behavior).
Also the evolving-intent-specific leak: does any early turn foreshadow the
final function before its scheduled switch, collapsing the evolution?

**4. What is the cheapest path through this task?**
HUD's core grader property: the highest reward available without doing the
work the task is about must sit at or below the floor. The no-op gate
checks the zero-edit path mechanically; you check the paths no fixed probe
enumerates. For multi-turn arms specifically: could an agent pass by
acting on the final turn alone, ignoring everything the evolution was
supposed to make it integrate? If yes, the evolved arm is not applying its
intervention, and any static-vs-evolved delta is noise.

**5. What does this gate failure actually mean?**
For triage invocations. The prior (Anthropic): consistent failure usually
means a broken task or grader, not an incapable model. Read the admission
record's evidence before proposing anything: a gold-check WRONG is a broken
task or a mis-wired harness, never retry-worthy; repeated `RunFailure`s are
infrastructure; a no-op pass means the task was vacuous. Then ask the
population question (the evolving-intent viability lesson): does the
proposed fix or the rejection pattern remove sources *selectively* — e.g.
all multi-argument sources, all of one repo — quietly reshaping the
population one arm's results will be compared on?

## Recording a verdict

Write a short markdown verdict into the family's research folder
(`parallax/research/<investigation>/verdicts/`). Required content — kept
minimal so the record is auditable, not ceremonial:

- the identity of what was reviewed: `Spec digest:` line
  (`TaskSpecV1.spec_digest`), plus the source id;
- a `Verdict:` line — `admit`, `admit-with-notes`, or `reject`;
- at least one observation tied to a specific arm and turn (or artifact
  path), so the next reader can see what you saw;
- no quoted sealed material, no pasted patch hunks.

Validate the record's mechanical shape (never the judgment):

```bash
python3 parallax/.cursor/skills/review-task-admission/scripts/validate_verdict.py path/to/verdict.md
```

A rejection verdict should say which of the five questions failed and
point at the turn that failed it. An admit verdict can be three lines.
Disagreement with a mechanical gate (you believe a rejected task is fine)
goes in the verdict as a note — the gate still wins until the pipeline is
changed; the verdict is the evidence for changing it.
