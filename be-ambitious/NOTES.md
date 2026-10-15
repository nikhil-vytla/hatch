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

- **Skill name `be-ambitious`.** I first used `ambition`. The user asked
  for `be-ambitious` as the name of both the skill and the folder, so the
  experiment folder is now `be-ambitious/` and the skill lives in
  `be-ambitious/be-ambitious/`. The spec requires `name` to match the skill
  directory. The prose still uses "ambition" as the concept word.
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

## Evals (2026-10-15)

- Model: `opencode/deepseek-v4.1-flash-free` via `opencode run`. Before running, I confirmed in `opencode models opencode --verbose` that the provider is OpenCode: providerID `opencode`, api url `https://opencode.ai/inference/v1`, and cost 0 for input, output and cache. The `--format json` stream reports `cost` on each `step_finish`, and the harness asserts it is 0 on every call. I never used the paid pi route.
- `opencode run` wraps each call in its build-agent system prompt (~11k input tokens). That prompt is the same in every condition, so it is a constant. I run each call in an empty scratch dir with `--pure` so the agent has nothing to read.
- The user asked to rename the skill and its folder to `be-ambitious`. I renamed the experiment folder too, and the evals use the new name.

### Eval design

- 10 plain, task-by-task requests across domains (`evals/cases.py`), each wrapped in "help me be more ambitious with this".
- Conditions:
  - `baseline`: the request alone.
  - `baseline_long`: the same request plus "~800 words", as a length control.
  - `skill_body`: the request with SKILL.md only.
  - `skill_full`: the request with SKILL.md, every reference and every asset inlined.
  - 3 samples each.
- Blind rubric: 12 binary items grounded in the *article's* techniques rather than the skill's template. A blind pairwise judge saw both presentation orders. The judge is the same free model as the generator. That is a known limitation (self-preference), but it applies equally to all conditions.
- Trigger eval: 10 should-fire and 10 shouldn't-fire queries against a list of 7 skills (6 distractors, including a near-miss `prompt-polish`), with positions shuffled.

### v1 results (the skill as first written)

- Trigger: P 1.00, R 0.97 (one miss on "stop micro-prompting"). The set is easy: positives use explicit ambition words.
- Rubric overall:
  - baseline 0.47
  - baseline_long 0.61
  - skill_body 0.93
  - skill_full 0.98
- The rubric is close to circular (the skill teaches these items), so read it as fidelity to the article rather than proof of value. "Grounded" scored 1.00 everywhere, so the judge is lenient there.
- Pairwise skill_full vs baseline: the skill won 51 of 59 (0.86). Only 23 of 29 pairs were position-consistent.
- **Reading the 8 baseline wins was the most useful part.** The skill lost when it overreached:
  - rungs needing cross-system data pipelines for a QBR or survey;
  - a lit review asking the model to run a meta-analysis, which invites fabricated effect sizes;
  - an unrealistic "p95 LCP ≤ 200 ms" target.
- **Example anchoring.** A leakage count (`evals/leakage.py`) found DuckDB in 11 of 30 skill_full answers and 0 in every other condition, including launch emails and hiring JDs. Back-test showed up in 13 of 30. The worked example's toolkit was being copied into unrelated fields. skill_body, which never sees the worked example, barely leaks. The "200 ms" in the depth move is the likely source of the unrealistic target.
- One skill_body generation was truncated (87 words). I left it in the data.

### v2 changes (targeted at those failures)

- Step 3 asks for instruments *native to the user's field* and gives three cross-field examples. It says example tools belong to their examples.
- The stretch target must sit beside its baseline and be something a top practitioner would still call achievable. "200 ms" became "5 s → under 1 s".
- Step 5 requires an executor for every step (model here / model with access / person). Numbers the model can't compute become code or a protocol, not values.
- Step 6 recommends the highest rung runnable on what the user already has. Higher rungs are presented as upgrades, each with its first unlock.
- worked-example.md is framed as "shape, not toolkit". I added a non-analytics contrast: a launch email using an email platform's holdout groups.
- I added post-hoc rubric items R13 (executable, no invented numbers) and R14 (domain-native tools). They are graded on *all* conditions, including v1, so the comparison stays fair. They were written after seeing v1's failures, so v2 is tuned to them. Pairwise against the baselines is the check that doesn't depend on those items.

### v2 eval: not run

- My first v2 launch overlapped with three pairwise jobs, about 18 concurrent calls. Every v2 generation timed out. When I retried at low concurrency, the free endpoint no longer answered even a one-word "PONG" within 120 s. I stopped there because the user asked to wrap up.
- **The v2 edits to the skill are therefore unverified.** They are motivated by the v1 failures, but nothing has measured them. v1, as evaluated, is the skill at commit `404b412` (named `ambition` there), plus the rename.
- Lesson: the free OpenCode endpoint copes with about 6–10 concurrent calls. Run stages one after another, never several pools in parallel.
- Of the extra pairwise runs, skill_body vs baseline finished 43 of 60 and skill_full vs baseline_long finished 33 of 60. The rest timed out. The results report n alongside each rate.
- I deleted the raw `.log` files because their error messages echoed full prompts. The JSONL rows hold everything needed to rerun the analysis.
