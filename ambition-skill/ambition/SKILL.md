---
name: ambition
description: Raises the ambition of a task given to an AI model along three axes (altitude, depth and range), then rewrites the request as a ladder of more ambitious prompts. Each rung names its verifier and the access it needs. Use when the user asks to think bigger or be more ambitious, wants to get more out of a model, asks to upgrade a prompt or plan, or asks what else AI could do for a piece of work.
metadata:
  source: "https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/"
  source-author: Felix Rieseberg
  version: "1.0"
---

# Ambition

Models now do more than most people ask of them. The gap between what's possible and what gets asked is usually a failure of **ambition**, not of capability. This skill closes that gap in a set order. Doing the same task faster (**speed**) is the default, so it isn't covered here. The work is in three other axes:

- **Altitude**: aim at the outcome, not the task.
- **Depth**: do the task the way the best practitioner in the field would.
- **Range**: bring in more fields than one person could practically consult.

## Modes

- **Advise**: the user wants their request, prompt or plan made more ambitious. The deliverable is the ladder from step 6.
- **Self-apply**: you're about to start a task and want to raise its ambition first. Build the ladder, then do the rung the user approved. Present the higher rungs as an offer. The user chooses the rung.

## Steps

### 1. Baseline

Write the task as the user stated it, in one sentence. That's rung 0. Note the domain, the user's apparent role, and the materials they've mentioned.
**Done when:** rung 0 is one sentence a stranger could carry out.

### 2. Altitude: climb to the outcome

Ask "and then what should happen?" repeatedly until you reach the outcome the user actually cares about. Stop one level before the goal turns abstract ("grow revenue", "make money"). Models don't yet handle that level well. Good signals:
- The task would normally take a meeting.
- The same request keeps coming back (fix *this* crash → keep the app crash-free).
- The output is a document whose only job is to set off a decision.

Design the **durable workflow** that would reach that outcome without a human prompting each step. List what it needs: data feeds, mappings, test machines, schedules. Getting there often means changing the user's own workflow, so say that plainly.
**Done when:** you've named one concrete, checkable outcome above rung 0 and the workflow that would sustain it. Alternatively, state why the task is already at its natural altitude.
Techniques and examples: [references/altitude.md](references/altitude.md).

### 3. Depth: make it deeper, not bigger

Answer these four questions for the task:
1. What would a top professional do here that the user hasn't asked for?
2. What is the rawest material they'd start from?
3. Which specific methods, instruments and tools would they use? Name real ones (a database and a survival model, not "a thorough analysis").
4. What outside the model and the user would judge whether the result is right? Examples: a test suite, a holdout set, a benchmark, a profiler, a domain expert, the market.

Then apply the depth moves:
- **Set an unreasonable target and frame it as reachable.** Example: 200 ms where 5 s was asked.
- **Test the premise** against raw data before building on it.
- **Produce new knowledge**: a signal, a simulation or a finding the user doesn't have yet, validated on data the model hasn't seen.

Changing the vocabulary of a task isn't depth. Depth means the methods change.
**Done when:** all four questions have specific answers and every claim in the plan has an outside judge.
Techniques and the rewrite prompt: [references/depth.md](references/depth.md), [assets/depth-rewrite-prompt.md](assets/depth-rewrite-prompt.md).

### 4. Range: pull in other fields

Restate the task's nouns as verbs. "A deck" becomes "get busy people to believe a cause-and-effect story and decide in 30 minutes". Each verb points to fields that are good at that verb. Assemble a **crew** of 3–6 disciplines from those fields. Include at least one adversary, someone whose job is to break the conclusion. A short seller and a forensic accountant are examples. Give each crew member the activities that discipline performs: the methods, checks and artefacts. Running members as parallel subagents makes this cheap.
**Done when:** each crew member has one named method and one artefact it contributes, and at least one member is adversarial.
Techniques and examples: [references/range.md](references/range.md).

### 5. Prerequisites

Every axis depends on the model having a real working environment. List what's missing:
- A computer it can use, with permission to install software.
- Access to the data, through connectors, exports or credentials the user grants.
- The outside judge from step 3, ideally as a tool the model can call for fast feedback.

**Done when:** every rung has a verifier and its access needs are stated as concrete asks to the user.

### 6. Deliver the ambition ladder

Use the format in [assets/ambition-ladder-template.md](assets/ambition-ladder-template.md): rung 0, then one rung per axis that applies, then one combined rung. Each rung has:
- the prompt, rewritten so it's ready to paste;
- the outside judge;
- the access it needs;
- what it costs the user (time, workflow change, risk).

If an axis doesn't apply, give it one line saying why. Recommend one rung, and pick the highest one the user can supply prerequisites for today.

If the user hesitates over a goal that sounds out of reach, or you do, read [references/self-efficacy.md](references/self-efficacy.md) before lowering it.

A fully worked example (Acme quarterly review and churn analysis on every axis) is in [references/worked-example.md](references/worked-example.md). Attribution and the line between the source article and this skill's additions are in [references/source.md](references/source.md).
