# Notes

## Goal

Turn Felix Rieseberg's essay "How to be more ambitious: A tutorial for humans
with models" into an Agent Skill in the agentskills.io format, with
references.

## Log

- Fetched the article with WebFetch and asked for a section-by-section account.
  It has four kinds of ambition: **speed**, **altitude**, **depth** and
  **range**. The author skips speed because it takes no creativity. The
  article has two running examples (an "Acme Inc." quarterly business review
  and a churn analysis), a reusable "deeper, not bigger" prompt pattern, and
  a closing section on self-efficacy ("we have been here before").
- Fetched the agentskills.io spec. Requirements I checked:
  - `name`: 1–64 characters, lowercase letters, digits and hyphens only, no
    leading, trailing or doubled hyphens, and it must match the directory name.
  - `description`: 1–1024 characters, saying both what the skill does and
    when to use it.
  - Optional fields: `license`, `compatibility` (≤500 characters),
    `metadata` (string→string) and `allowed-tools`.
  - Keep `SKILL.md` under 500 lines and about 5k tokens. Put detail in
    `references/` and keep file references one level deep.
  - Validator: the `skills-ref` package. The executable is `agentskills`, not
    `skills-ref` as the docs say. Run it with
    `uvx --from skills-ref agentskills validate <dir>`.
- Loaded the local `writing-for-agents` skill for guidance on writing skills.
  The parts I used:
  - Leading words. The four axis names are good ones, because the article
    already uses them as compact handles.
  - Each step needs a completion criterion.
  - Use disclosure by branch: material only some cases need goes behind a
    pointer.
  - State positive targets. For example, write "do the activities of a role"
    in place of "don't role-play".

## Design decisions

- **Skill name `ambition`.** It's one word, and it's the word users actually
  say ("be more ambitious", "think bigger").
- **SKILL.md is a procedure.** The steps are: baseline → altitude → depth →
  range → prerequisites → an "ambition ladder" as output. Every task goes
  through every step, so all of them stay inline.
- **Disclosed references.** Each axis gets its own reference file, with the
  techniques and examples a run needs only when that axis is the hard one.
  The worked Acme example has its own file. The self-efficacy evidence has
  its own file, because it matters only when the user (or the agent) doubts
  a goal is reachable.
- **Prompt template in `assets/`.** The depth-rewrite prompt is something
  the agent pastes or adapts, so it's an asset rather than reference.
- **Two modes.** (a) Advise: the user wants their request or plan made more
  ambitious. (b) Self-apply: the agent raises its own ambition on a task
  before starting it. Self-apply needs a guardrail: propose the higher
  rungs, but carry out only the rung the user signed off on. Otherwise
  "ambition" turns into scope creep.
- **Copyright.** The article is summarized in my own words, and I kept
  direct quotes very short. `references/source.md` records attribution and
  separates the article's points from my additions (the guardrails, the
  ladder output format and the "doesn't apply" escape hatch).
- **The article's examples where it says "no".** It notes that open-ended
  goals like "make money" don't work yet, that role play can make
  transcripts strange, and that a model shouldn't grade its own work. I put
  each of these into the matching step as a positive check.
