# be-ambitious: an Agent Skill distilled from "How to be more ambitious"

Felix Rieseberg's essay [How to be more ambitious: A tutorial for humans with models](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/) argues that most people ask far less of models than the models can deliver. It sorts the missing ambition into four types: **speed, altitude, depth and range**. This folder turns that essay into a reusable skill in the [agentskills.io](https://agentskills.io/specification) format. An agent can load the skill to turn a plain request into a ladder of more ambitious, verifiable prompts.

## What's here

```
be-ambitious/
├── NOTES.md                       working notes and design decisions
├── README.md                      this report
└── be-ambitious/                  the skill (drop this folder into any skills directory)
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
evals/                             harness, raw results and summary (see Evals below)
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
uvx --from skills-ref agentskills validate be-ambitious
```

Result: `Valid skill: be-ambitious`. `SKILL.md` is 85 lines and about 1k words, inside the spec's 500-line and ~5k-token guidance. The description is under the 1024-character limit. Every relative link resolves.

Note: the spec's docs say to run `skills-ref validate`, but the PyPI package installs its executable as `agentskills`.

## Evals

I ran the evals with `opencode/deepseek-v4.1-flash-free`, which served as both generator and judge. Before running, I confirmed the provider is OpenCode (`opencode.ai/inference/v1`, cost 0). The harness also checks that every call reports `cost: 0`, and the total was 0. All code is in [evals/](evals/), and the full tables are in [evals/results/summary.md](evals/results/summary.md).

**Setup.**
- I used 10 plain requests, such as fixing a crash, a QBR deck, unit tests, a launch email or a lit review. Each was wrapped in "help me be more ambitious with this".
- Conditions:
  - `baseline`: the request alone.
  - `baseline_long`: the same request plus "~800 words", as a length control.
  - `skill_body`: the request with SKILL.md only.
  - `skill_full`: the request with SKILL.md, references and assets.
- I ran 3 samples per condition, 120 generations in total.
- Grading: a blind 12-item rubric, plus blind pairwise judgements in both presentation orders.
- A separate trigger eval used 20 queries against 7 skill descriptions.

**Results (v1, the skill as first published in this PR):**

| | baseline | baseline_long | skill_body | skill_full |
|---|---|---|---|---|
| Mean words | 341 | 772 | 792 | 858 |
| Rubric overall (95% CI) | 0.47 [0.42, 0.51] | 0.61 [0.56, 0.66] | 0.93 [0.86, 0.97] | 0.98 [0.97, 0.99] |

| Pairwise (blind) | n | skill win rate |
|---|---|---|
| skill_full vs baseline | 60 | **0.87** |
| skill_full vs baseline_long (length-matched) | 33 | **0.79** |
| skill_body vs baseline | 43 | 0.77 |

Trigger: precision **1.00** and recall **0.97** over 60 calls. The one miss was "how do I give the model the outcome instead of the task?", which loaded the skill 2 of 3 times. The near-miss distractor `prompt-polish` never stole a positive, and the skill never fired on routine asks like "fix this NPE" or "summarize this PDF".

**What the numbers mean, and what they don't.**
- **The skill reliably changes what the model proposes.** The biggest gains are on things the baseline almost never offers:
  - durable workflows: 0.07 → 0.90;
  - other disciplines: 0.00 → 1.00;
  - stretch targets: 0.17 → 0.90;
  - testing the user's premise: 0.30 → 1.00.

  Asking the baseline for more words recovers only part of this, 0.61 overall.
- **The rubric is close to circular.** It is built from the article's techniques, and the skill teaches them. Read it as fidelity to the article. The pairwise judge is the fairer test of value, and the skill still wins 79% of comparisons against a length-matched baseline.
- **Caveats on the judge.** It is the same model as the generator. Only 24 of 30 skill_full-vs-baseline pairs got the same verdict in both orders, and only 9 of 16 in the length-matched comparison. The "grounded" item scored 1.00 everywhere, so it is too lenient to tell conditions apart.

**What the evals found wrong with v1.** I read every pairwise loss, then ran a leakage count ([evals/results/leakage.md](evals/results/leakage.md)). Two failure modes stood out:

1. **Example anchoring.** With the references loaded, the model copied the worked example's toolkit into unrelated fields. DuckDB appeared in 11 of 30 skill_full answers, including launch emails and hiring JDs, against 0 in every other condition. "Back-test" appeared in 13 of 30.
2. **Overreach.** The baseline won when the skill proposed things the user or model couldn't execute. Examples: cross-system pipelines for a QBR, a model "running" a meta-analysis (which invites fabricated effect sizes), and a p95 LCP ≤ 200 ms target, echoing the "200 ms" example in the skill.

**v2 changes (in this folder, not yet evaluated).**
- Instruments must be *native to the user's field*, and example tools are labelled as belonging to their examples.
- Stretch targets sit next to a baseline and must be something a top practitioner would call achievable.
- Every step names an executor. Numbers the model can't compute become code or a protocol.
- The recommended rung is the highest one runnable on what the user already has.
- The worked examples file gains a non-analytics contrast (a launch email).

I started the v2 re-run, but the free endpoint stopped responding: every call timed out, including a one-word ping. **The v2 edits are motivated by the evidence but unverified.** The v1 that was evaluated is commit `404b412`.

Reproduce:

```bash
cd be-ambitious/evals && python3 run.py all --samples 3 --workers 6 && python3 analyze.py && python3 leakage.py
```

## Gaps and next steps

- **Re-run v2.** Run `gen --conds skill_body_v2,skill_full_v2`, then `rubric`, `rubric_extra` (post-hoc R13 executable / R14 domain-native, graded on all conditions) and `pairwise --vs skill_full_v2`. Do one stage at a time: the free endpoint handles about 6–10 concurrent calls.
- **Use a different-family judge** to remove self-preference, and a human spot-check on a sample.
- **Harder trigger set.** The current positives all use explicit "ambitious / bigger / upgrade" wording.
- **Self-apply mode is untested.** Nothing enforces "carry out only the approved rung". A harness could make that a required confirmation.
