# be-ambitious: an Agent Skill distilled from "How to be more ambitious"

Felix Rieseberg's essay [How to be more ambitious: A tutorial for humans with models](https://felixrieseberg.com/how-to-be-more-ambitious-a-tutorial-for-humans-with-models/) argues that most people ask far less of models than the models can deliver. It sorts the missing ambition into four types: **speed, altitude, depth and range**. This folder distills the essay into a short skill in the [agentskills.io](https://agentskills.io/specification) format. The skill is a principle with guardrails, not a procedure. The format follows Lauren Tan's [pstack](https://cursor.com/lp-team/lauren) principle skills.

## What's here

```
be-ambitious/
├── NOTES.md                 working notes and design decisions
├── README.md                this report
└── be-ambitious/            the skill (drop this folder into any skills directory)
    ├── SKILL.md             principle, why, three axes, guardrails (24 lines)
    └── references/
        ├── altitude.md      the outcome question, signals, the QBR climb, durable workflows (16 lines)
        ├── depth.md         five depth moves and the "deeper, not bigger" prompt (21 lines)
        └── range.md         nouns→verbs, the crew, activities not personas (11 lines)
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

**v1 (commit `404b412`)** was a 6-step procedure (85 lines) with completion criteria and two modes. Its output was an "ambition ladder" template with a judge, access needs and a cost for each rung. It had six references and two assets, about 370 lines in total. A worked Acme example used specific tools.

**v3 (current)** is the article's best ideas in the pstack principle shape: a one-line rule, **Why**, **Pattern** and **Guardrails**. Each reference is 11–21 lines. I questioned every addition I had made beyond the article:

| Added in v1 | v3 | Reason |
|---|---|---|
| Step order, "Done when" criteria, advise/self-apply modes | Cut | They box the model in. The model already knows how to structure an answer. |
| Ladder template (judge / access / cost per rung) | Cut | It made every answer template-shaped. The judge and access needs survive as guardrails. |
| Worked Acme example with named tools | Cut | In an early eval run (not included here), its tools leaked into unrelated answers: DuckDB showed up in 11 of 30, launch emails included. |
| Self-efficacy reference | One line in **Why** | Motivation, not instruction |
| `source.md` attribution file | Frontmatter `metadata` | Attribution without a file |
| v2 patches (domain-native tools, executor per step, baseline beside every target) | Cut | They fixed problems that v1's own additions caused. Remove the cause instead. |
| "The user chooses how far to go" | **Kept** as a guardrail | Without it, ambition turns into scope creep. |

I also cut the article's own numbers ("5 s → 200 ms") from the depth move. The same run showed literal numbers in the skill leaking into unrelated answers.

The validator passes: `uvx --from skills-ref agentskills validate be-ambitious` reports `Valid skill: be-ambitious`. The spec docs name the CLI `skills-ref`, but the PyPI package installs it as `agentskills`.

## Next steps

- **Evaluate the current version.** Compare it blind against a plain request, a length-matched request, and v1. Use a judge from a different model family than the generator.
- **Test triggering on harder queries** that ask for ambition without using words like "ambitious" or "bigger".
