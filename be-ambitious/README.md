# be-ambitious: an Agent Skill distilled from "How to be more ambitious"

Felix Rieseberg's essay [How to be more ambitious: A tutorial for humans with models](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/) argues that most people ask far less of models than the models can deliver. It sorts the missing ambition into four types: **speed, altitude, depth and range**. This folder distills the essay into a short skill in the [agentskills.io](https://agentskills.io/specification) format. The skill is a principle with guardrails, not a procedure. The format follows Lauren Tan's [pstack](https://cursor.com/lp-team/lauren) principle skills.

## What's here

```
be-ambitious/
├── NOTES.md                 working notes and design decisions
├── README.md                this report
├── be-ambitious/            the skill (drop this folder into any skills directory)
│   ├── SKILL.md             principle, why, three axes, guardrails (24 lines)
│   └── references/
│       ├── altitude.md      the outcome question, signals, the QBR climb, durable workflows (16 lines)
│       ├── depth.md         five depth moves and the "deeper, not bigger" prompt (21 lines)
│       └── range.md         nouns→verbs, the crew, activities not personas (11 lines)
└── evals/                   harness, raw results and summary (see Evals)
```

## Distilling the essay

| Essay idea | Where it lives |
|---|---|
| Capabilities are uneven and move faster than our sense of them | SKILL.md **Why** |
| Speed is the uncreative default | One clause in **Pattern** |
| **Altitude**: "what do you want to happen next?"; meetings as a signal; the QBR climb; durable workflows; open goals don't work yet | SKILL.md + `altitude.md` |
| **Depth**: deeper not bigger; instruments over vocabulary; unreasonable targets; challenge assumptions; new knowledge; outside judge; the four-question rewrite | SKILL.md + `depth.md` |
| **Range**: nouns→verbs; crew with a short seller and a forensic accountant; activities not personas; seeing tools used in other fields | SKILL.md + `range.md` |
| Needs a usable computer and data access | Guardrail |
| Self-efficacy ("we have been here before") | One line in **Why**: specific, hard goals beat "do your best" |

## Design: two versions

**v1 (commit `404b412`, the version evaluated below)** was a 6-step procedure (85 lines) with completion criteria and two modes. Its output was an "ambition ladder" template with a judge, access needs and a cost for each rung. It had six references and two assets, about 370 lines in total. A worked Acme example used specific tools.

**v3 (current)** is the article's best ideas in the pstack principle shape: a one-line rule, **Why**, **Pattern** and **Guardrails**. Each reference is 11–21 lines. I questioned every addition I had made beyond the article:

| Added in v1 | v3 | Reason |
|---|---|---|
| Step order, "Done when" criteria, advise/self-apply modes | Cut | They box the model in. The model already knows how to structure an answer. |
| Ladder template (judge / access / cost per rung) | Cut | It made every answer template-shaped. The judge and access needs survive as guardrails. |
| Worked Acme example with named tools | Cut | It directly caused the example anchoring the evals found (DuckDB in 11 of 30 answers). |
| Self-efficacy reference | One line in **Why** | Motivation, not instruction |
| `source.md` attribution file | Frontmatter `metadata` | Attribution without a file |
| v2 patches (domain-native tools, executor per step, baseline beside every target) | Cut | They fixed problems that v1's own additions caused. Remove the cause instead. |
| "The user chooses how far to go" | **Kept** as a guardrail | Without it, ambition turns into scope creep. |

I also cut the article's own numbers ("5 s → 200 ms") from the depth move. The evals showed literal numbers in the skill leaking into unrelated answers.

The validator passes: `uvx --from skills-ref agentskills validate be-ambitious` reports `Valid skill: be-ambitious`. The spec docs name the CLI `skills-ref`, but the PyPI package installs it as `agentskills`.

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

**After v1.** I wrote v2 patches aimed at those failures, but the free endpoint stopped responding before they could be measured. v2 was then replaced by the minimal v3 described above, which removes the causes (the worked example, the literal numbers, the template) instead of patching around them. **v3 is not evaluated yet.** The v1 numbers describe a different, longer skill. Note that the v1 ladder template probably earned some of its rubric points (ready-to-paste prompt, access needs). Expect v3 to score lower on those items, and judge it mainly on the pairwise comparisons.

Reproduce:

```bash
cd be-ambitious/evals && python3 run.py all --samples 3 --workers 6 && python3 analyze.py && python3 leakage.py
```

## Gaps and next steps

- **Evaluate v3** against the same baselines, one stage at a time (the free endpoint handles about 6–10 concurrent calls):

  ```bash
  cd be-ambitious/evals
  python3 run.py gen --conds skill_body_v3,skill_full_v3 --workers 6
  python3 run.py rubric --workers 6
  python3 run.py pairwise --base baseline --vs skill_full_v3 --workers 6
  python3 run.py pairwise --base skill_full --vs skill_full_v3 --workers 6
  python3 analyze.py && python3 leakage.py
  ```

  The last pairwise run compares v3 directly against v1. That comparison is the real test of "shorter is better".
- **Use a judge from a different model family** to remove self-preference, and have a human spot-check a sample.
- **Harder trigger set.** The current positives all use explicit "ambitious / bigger / upgrade" wording.
