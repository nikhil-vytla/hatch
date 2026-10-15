# ambition: an Agent Skill distilled from "How to be more ambitious"

Felix Rieseberg's essay [How to be more ambitious: A tutorial for humans with models](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/) argues that most people ask far less of models than the models can deliver. It sorts the missing ambition into four types: **speed, altitude, depth and range**. This folder turns that essay into a reusable skill in the [agentskills.io](https://agentskills.io/specification) format. An agent can load the skill to turn a plain request into a ladder of more ambitious, verifiable prompts.

## What's here

```
ambition-skill/
├── NOTES.md                       working notes and design decisions
├── README.md                      this report
└── ambition/                      the skill (drop this folder into any skills directory)
    ├── SKILL.md                   6-step procedure, ~85 lines
    ├── references/
    │   ├── altitude.md            climbing to the outcome; durable workflows; analyse→decide→redesign ladder
    │   ├── depth.md               instruments over vocabulary; five depth moves; four-question rewrite
    │   ├── range.md               nouns→verbs; assembling a crew with adversaries; activities not personas
    │   ├── self-efficacy.md       evidence and triage for when a goal feels out of reach
    │   ├── worked-example.md      Acme Inc. QBR and churn analysis on every axis
    │   └── source.md              attribution, and what is the article vs. what this skill adds
    └── assets/
        ├── depth-rewrite-prompt.md     ready-to-paste "deeper, not bigger" prompt
        └── ambition-ladder-template.md the output format
```

## Distilling the essay

| Essay idea | Where it lives in the skill |
|---|---|
| Speed is the uncreative default | Named in the intro, then skipped |
| **Altitude**: ask for the outcome; "what should happen next?" | Step 2 + `altitude.md` |
| Meetings as a signal; open-ended goals still don't work | Step 2 signals; "stop one level before abstract" |
| Durable workflows need access and workflow changes | Step 2 + step 5 prerequisites; "cost to you" on each rung |
| **Depth**: work like top professionals, until experts could learn from it | Step 3 + `depth.md` |
| Instruments, unreasonable-but-reachable goals, test the premise, new knowledge, outside judge | The five depth moves |
| "Deeper, not bigger" four-question rewrite | Step 3 + `assets/depth-rewrite-prompt.md` |
| **Range**: many fields via subagents | Step 4 + `range.md` |
| Nouns→verbs; crew with a short seller and a forensic accountant | Step 4 crew with at least one adversary |
| Role play makes transcripts weird | Stated positively: "assign activities, not personas" |
| Needs a usable computer and data connectors | Step 5 |
| "We have been here before": self-efficacy | `self-efficacy.md`, loaded only when a goal is about to be lowered |

## Design choices

- **A procedure, not an essay.** The skill body is six ordered steps, each with a "Done when" criterion: baseline, altitude, depth, range, prerequisites, deliver the ladder. The essay's narrative and examples sit in references that load on demand.
- **The output is an *ambition ladder*.** Each rung includes a ready-to-paste prompt, its **outside judge**, the access it needs and what it costs the user. The essay's strongest practical warning is "don't let the model grade its own work", so a rung without a verifier counts as unfinished.
- **Two modes.** *Advise* returns the ladder to the user. *Self-apply* is for an agent raising its own ambition before a task. It proposes the higher rungs and then carries out only the rung the user picked, so that ambition doesn't turn into scope creep.
- **Disclosure by branch.** Every run needs the six steps, so they stay inline. The self-efficacy material is needed only when someone wants to lower a goal, so it sits behind a conditional pointer.
- **Attribution and copyright.** Everything is paraphrased, and quotes are kept to a few words. `references/source.md` separates the article's ideas from this skill's additions: the step order, the ladder format, the specific tools in the worked example and the capability-vs-belief triage.

## Validation

The skill passes the reference validator:

```bash
uvx --from skills-ref agentskills validate ambition
```

Result: `Valid skill: ambition`. `SKILL.md` is 85 lines and about 1k words, inside the spec's 500-line and ~5k-token guidance. The description is under the 1024-character limit. Every relative link resolves.

Note: the spec's docs say to run `skills-ref validate`, but the PyPI package installs its executable as `agentskills`.

## Gaps and next steps

- **No behavioural eval yet.** Validation checks the format, not the effect. A useful next experiment would give a model ~10 plain requests (bug fixes, decks, analyses) with and without the skill and grade the ladders blind. The grading would ask whether each rung names real instruments, an outside judge and concrete access asks.
- **Triggering is untuned.** The description fires on explicit "ambition / think bigger / upgrade this prompt" phrasing. It deliberately doesn't fire on every routine task, to avoid over-triggering. Measuring whether that balance is right needs a trigger eval.
- **Self-apply relies on the agent's judgement.** Nothing enforces "carry out only the approved rung". A harness could make that a required confirmation.
