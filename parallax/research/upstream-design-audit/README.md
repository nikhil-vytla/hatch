# Upstream design audit: experimental arms, admission QC, turn delivery

Three Parallax design decisions were made in the name of scientific rigor:
a three-arm paired experimental design, a formal admission-gate concept, and
an agent-callable `advance()` turn tool. This audit checks each against what
the upstream papers and codebases actually do, so we can decide what is
faithful replication, what is our own addition, and whether each addition is
worth its cost right now.

## Sources and pins

| Source | Identity | How consulted |
|---|---|---|
| microsoft/evolving-intent | commit `993d6be9597ac03854b46362ccd647eb1bfd267a` (repo HEAD on 2026-08-02 equals the pin in `parallax/docs/methods/evolving-intent.md`) | read-only clone in `/tmp` |
| "LLMs Get Lost in Evolving User Intent" (Tack, Laban, Neville) | [arXiv:2607.20734](https://arxiv.org/abs/2607.20734) — exact ID confirmed from the repo README badge and BibTeX block | full text |
| SprocketLab/slop-code-bench | commit `8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b` (repo HEAD on 2026-08-02, same commit pinned in `parallax/docs/methods/checkpoint-evolution.md`) | read-only clone in `/tmp` |
| "SlopCodeBench" (Orlanski et al.) | [arXiv:2603.24755](https://arxiv.org/abs/2603.24755) | full text (v1 and current) |
| Parallax | `parallax/docs/` (MODEL.md, methods/, decisions/) and `parallax/src/parallax/swebench_env.py` on `origin/main`; archived `UPSTREAM-SWE-OVERLAY.md` on branch `cursor/hard-repo-tasks-5fc8` | this repo |
| Survey targets | SWE-smith (arXiv:2504.21798), SWE-Gym (arXiv:2412.21139), Prime Intellect Environments Hub, Self-Instruct (arXiv:2212.10560) | papers + published docs |

All file:line citations below are against the pinned commits.

---

## Q1 — Does upstream have controlled experimental arms, or post-hoc aggregate comparison?

**Answer: post-hoc aggregate comparison over a shared source subset. The
three-arm paired design with paired statistics is a Parallax addition.**

### What the evolving-intent repo does

- Conditions are *scenarios*, inferred from run flags
  (`evaluation/runners/run_experiment.py:87-99`): `fully_specified` (t=1),
  `under_specified` (t>1, no intent changes), `argument_revision`,
  `function_switch`, `combined`. Each scenario is an independent run that
  writes one results JSON; the run summary is aggregate accuracy
  `correct/total` (`run_experiment.py:768-828`).
- Same sources across conditions are achieved by **subset selection, not
  pairing**: `--task_ids_file` is documented as "JSON file with task_ids to
  filter (for fair comparison)" (`run_experiment.py:928-929`) and the
  published eval scripts point every scenario at the same fixed
  `intent_construction/eval_indices/*_task_ids.json`.
- There is **no statistical machinery anywhere in the repo**. Searching all
  Python files for t-test / Wilcoxon / bootstrap / McNemar / scipy /
  p-value / confidence-interval code returns nothing. Comparison across
  conditions means reading two JSONs and comparing mean accuracies; the
  final console output is a table of means (`run_experiment.py:1093-1097`).
- The published per-dataset eval scripts run exactly **two conditions** per
  model: `single` (t=1) and `evolve` (t=7, p=2, g=2)
  (`evaluation/scripts/run_gsm8k.sh:37-41`, `run_swe.sh:46-49`). No
  turn-matched control is in the published scripts. A turn-matched-ish
  condition (`under_specified`) exists only inside the optional
  `--run_plan` 25-config sweep (`run_experiment.py:974-988`).
- Budgets are **not matched across conditions**. In SWE, `single` gets a
  100-step cap for its one turn while `evolve` gets 200 steps *per turn*
  across up to 7 turns (`run_swe.sh:16-17,35-37`); the paper acknowledges
  raising the evolve budget for two models that hit limits (§5, setup).

### What the paper does

- Main result (Table 1): Single vs Evolve mean accuracy per model/dataset
  with relative-change percentages and a color scale. No error bars, no
  tests, no paired analysis.
- The turn-matched no-evolution control **does exist in the paper — but
  only as Appendix F.4**, run after the fact on GSM8K: they repeat prior
  turns without intent changes and observe accuracy "remains comparable,"
  concluding degradation is driven by intent changes rather than turn
  count. Reported as a small table of means.
- Sample sizes are small and chosen for cost (200/100/100/50 per domain,
  Appendix B "Filtering and sampling").

### slop-code-bench

No arms at all in the Parallax sense — it is a benchmark. The paper reports
aggregate solve rates, fraction-of-trajectories degradation statistics,
medians and per-checkpoint slopes against a 473-repo human panel, plus a
prompt-intervention study. Descriptive statistics only; no hypothesis
tests in the paper or in `src/`.

### Honest reading and recommendation

Parallax's three-arm paired design (static / matched / evolved, matched
budgets, preregistered trial units, paired cluster-averaged reporting with
Hoeffding intervals — `parallax/docs/methods/evolving-intent.md`
"Controlled comparison" and "GSM8K slice choices") is **our addition**. It
is not "wrong" — it fixes real inferential holes in the upstream design:

- What the upstream comparison **can** conclude: a large aggregate delta on
  the same source IDs is real evidence that the evolved presentation is
  harder for that model. With drops of 15–100 relative percent on n=50–200,
  the paper doesn't need a t-test to make its qualitative point.
- What it **cannot** conclude: *why*. Turn count, per-turn budget shape,
  total budget (explicitly unequal in SWE), and prompt-surface changes all
  co-vary with "evolution." The paper itself felt this gap — that's why
  F.4 exists — but addressed it post-hoc, on one dataset, in an appendix.
- What arms buy: attribution (matched arm isolates the schedule effect from
  the turn-count/budget effect) and honest uncertainty at small n (paired
  per-source contrasts remove between-source variance, which dominates at
  n=50). What arms cost: a third arm is +50% inference cost over the
  two-condition design, plus the matched-arm construction, budget-matching,
  and reporting machinery — which is exactly the machinery that has been
  absorbing Parallax implementation effort.

**Recommendation: sequence, don't simplify away.** Run the upstream-shaped
two-condition comparison (static vs evolved, same sources, aggregate
accuracy) as the *screening gate* for each new domain slice — it is cheap,
it is literally the paper's design, and if the aggregate delta does not
reproduce there is nothing for the third arm to explain. Keep the matched
arm and paired statistics as the *confirmation stage*, run only after the
screening delta shows an effect worth attributing. Concretely:

1. Screening (paper parity): 2 arms, matched source IDs, aggregate means +
   a simple paired bootstrap over sources (nearly free to compute even if
   upstream didn't).
2. Confirmation (Parallax design): add the matched arm and the
   budget-matching invariant; report the paired estimand per `MODEL.md`.

This keeps the paper-replication claim honest ("we reproduce their
comparison") while reserving the expensive rigor for effects that survive
screening. What we should *not* do is silently keep unequal budgets the
way upstream's SWE scripts do; even in the screening stage, equal declared
budgets cost nothing and remove the most embarrassing confound.

---

## Q2 — What QC do task-generation efforts actually perform?

### Survey

| Effort | Automated structural | Execution-based | LLM-judge | Human review |
|---|---|---|---|---|
| evolving-intent | schema/viability filter across all 23 eval configs (`evaluation/scripts/filter_valid_samples.py`) | solvability: reference solver must reproduce the gold answer from the extracted intent (paper App. D.1; `dataset_impl/gsm8k/verifier.py:44-74`) | coverage check; counterfactual minimal-substitution check (App. D.2); predecessor function-validity + answer-preservation + cross-turn independence, majority of 3 runs with 2 feedback retries (App. D.3; `generate_predecessors.py:518-651`); BIRD eval-time lenient re-grading (`llm_judge_bird_sql.py`) | none |
| slop-code-bench | `slop-code problems status` (test/spec/solution layout checks, `docs/commands/problems.md`) | pytest suites are the verifier; validation phase attempted each checkpoint with an agent; reference solutions exist but several fail their own tests (`docs/KNOWN_ISSUES.md` — "tests are authoritative") | none | primary mechanism: author drafting + ≥1 other-author review, proposal-phase culling, final solvability pass (paper §2 "Problem Construction"); two published checklists (`docs/contributing-problems/checklist.md`, `review-checklist.md`) covering leakage, ambiguity ("could two correct implementations differ?"), determinism |
| SWE-smith | runtime cap (2 min) | core gate: candidate bug must break ≥1 previously passing test (F2P) in the containerized env | issue text generated by LLM, *not* validated (paper admits no checks for under-specification or solution leakage) | ~8 min/repo (install parsing, output parser) |
| SWE-Gym | versioning scripts | gold patch must pass more unit tests than the base repo (SWE-bench validation script); failures filtered out | none | ~200 annotation hours manually configuring per-instance dependencies |
| Prime Intellect Environments Hub | packaging/spec conformance (verifiers taskset/harness spec) | strongest found: **no-op validation** (tests must fail with zero edits), **gold-patch validation** (reference fix must pass; up to 10 retries to separate flaky from broken), independent second passes; `uv run validate` ships as a model-free tool | judge-based rubrics exist in some tasksets but are not the admission bar | exclusions persisted in verified re-uploads for public audit |
| Self-Instruct | ROUGE-L < 0.7 similarity vs pool, keyword blacklists, length/format heuristics | none | none | none (spot-check evaluation only) |

Patterns worth noting:

- Every serious *code* effort anchors admission on an executable check with
  a known answer: F2P breakage (SWE-smith), gold-patch pass (SWE-Gym,
  Prime Intellect), gold-answer reproduction (evolving-intent solvability).
- The one bidirectional check — Prime Intellect's no-op + gold pair — is
  the state of the art: it bounds both false positives (task solvable with
  zero edits) and false negatives (reference fix fails), and it retries to
  separate flakiness from brokenness.
- LLM-judges appear where the property is semantic and has no executable
  oracle (is this counterfactual a *minimal* substitution? is this
  predecessor a *plausible related* task?). Evolving-intent hardens them
  with majority voting and answer-anchored acceptance rules.
- Human review appears where the artifact is a *specification for future
  humans/agents* (slop-code-bench problems) rather than a mechanically
  derived instance. Its published form is a checklist, i.e., an
  agent-followable document.
- Nobody ships statistical QC (calibration of judge agreement, admission
  drift monitoring). That is beyond current practice.

### Recommendation for Parallax: (c) combination, with a clear split

**In-code (blocking admission gates)** — everything with an executable or
mechanical oracle:

- schema validity, frozen-model parsing, sealed-leakage lint (already the
  `MODEL.md` admission list);
- solvability/answer-preservation: reference-solver reproduction of the
  sealed answer from the constructed presentation (upstream App. D.1/D.3
  semantics, already in the GSM8K slice);
- the Prime Intellect pair, adapted per domain: **no-op check** (static arm
  budget-zero / empty submission must not pass the verifier) and
  **gold check** (source gold answer/patch must pass the sealed verifier in
  the constructed environment), with bounded retries classifying flaky vs
  broken;
- simulation viability (the evolving-intent 23-config lesson: admit only
  sources that can support every arm/config you plan to run, or you
  silently change the population between conditions);
- budget/turn-count matching verification across arms.

**Cursor skill (agent-driven review workflow)** — everything that is a
judgment call over a spec, where slop-code-bench's checklists are the
model:

- leakage review ("does any public turn hint at sealed authority or the
  final function before schedule says so?");
- ambiguity review ("could two correct agents interpret this turn
  differently?"), naturalness/coherence of rendered turns;
- review of *declared deviations* from upstream (evolving-intent.md already
  requires a rationale for each — a skill can enforce that the rationale
  exists and is coherent);
- triage of gate failures (the skill reads gate evidence and decides
  retry / fix / reject, like Prime Intellect's debug CLI workflow).

The dividing line: **if a check can be wrong in a way a regression test
would catch, it is code; if a check can only be wrong in a way a reviewer
argues about, it is a skill.** LLM-judge checks (counterfactual minimality
etc.) sit in code but below the primary gates: majority-voted, retained
with transcripts, and never the sole basis for admission — matching both
upstream practice and the existing `checkpoint-evolution.md` stance that
rubric judgments are "excluded from admission."

---

## Q3 — How does upstream deliver turns at runtime, and how does it grade?

**Answer: harness-side, unskippable, submission-interception delivery;
grading via the official SWE-bench harness. Parallax's agent-callable
`advance()` is a deviation we introduced.**

### Turn delivery (pinned commit 993d6be)

- Turns are fully scripted before the agent starts:
  `evaluation/runners/run_swe_mini_agent.py:104` builds
  `"_user_turns": [t["content"] for t in gs.turns if t["role"]=="user"]`
  from the simulator, and the comment at lines 92–94 says the mini-agent
  "receives the multi-turn script verbatim."
- The scaffold drives the loop itself and *intercepts submission*:
  `evaluation/common/swe_minisweagent_scaffold.py:16-21` (module
  docstring): "Whenever the agent tries to submit (raises `Submitted`) but
  we still have undelivered user turns, we *intercept* the submission,
  append the next user turn as a follow-up message, and resume. Only when
  the agent submits AFTER all user turns are delivered do we accept the
  patch as final." Implementation: the `except Submitted` branch at
  `swe_minisweagent_scaffold.py:714-749`.
- Injected turns are wrapped with an authority prefix:
  `_wrap_intent_update` at `swe_minisweagent_scaffold.py:408-424` — "Hold
  on — before you finalize, the user has new information… Do not submit
  yet unless this update has been fully incorporated."
- The second delivery trigger is per-turn budget exhaustion: the
  `except LimitsExceeded` branch at `swe_minisweagent_scaffold.py:750-787`
  advances to the next scripted turn and re-arms the per-turn step budget;
  only cost-cap or final-turn exhaustion terminates, with a last-resort
  `git diff` autosubmit (`:853-869`).
- **The agent cannot skip ahead or opt out.** Its only tool is bash
  (`BASH_TOOL`, `swe_minisweagent_scaffold.py:74,264`); there is no
  turn-control tool. An early submit is *converted into* the next user
  turn; the agent cannot end the episode before every scripted turn has
  been delivered, and it has no way to see future turns.
- The generic (non-SWE) runner is the same shape: the eval loop calls
  `sample.step(response)` / `sample.is_done()` on a schedule the model
  never controls (`evaluation/runners/run_experiment.py:281-348`;
  `situated_simulation/user_simulation.py:961-1027`).
- The paper states the same design (§5 setup): "extended to multi-turn by
  intercepting the agent's submission and injecting the next scripted user
  turn until the script is exhausted."

### Grading

- `evaluation/common/swe_harness.py` is a "wrapper around the official
  `swebench` library" (line 4). It imports
  `swebench.harness.run_evaluation.main` (line 234) and invokes it per
  instance (lines 273-288) against `princeton-nlp/SWE-bench_Verified`
  (line 50) with the canonical `swebench` image namespace (line 131).
  The runner scores through it at `run_swe_mini_agent.py:180-197`.

### Parallax comparison

- Parallax delivers turns through an MCP tool the agent calls:
  `advance(token)` at `parallax/src/parallax/swebench_env.py:112-124`,
  served by an in-container FastMCP "turn director" (`:31`, `:133-148`).
  The agent pulls turns; nothing forces it to. An agent can finish on turn
  0 without ever seeing the evolution, or drain all turns in its first
  steps and collapse the evolved arm into a static-like presentation. Both
  defeat the intervention that the evolved arm exists to apply. Upstream
  has the push-model equivalent of neither failure mode.
- Grading also differs: Parallax resets to `base_commit`, restores
  authoritative test files, applies the sealed test patch, and runs the
  pinned test command inside the official image itself
  (`swebench_env.py:48-109`; documented in
  `parallax/docs/methods/evolving-intent.md`, SWE slice), rather than
  calling `run_evaluation`. This one is a *declared* difference with the
  official image pinned by digest; the turn-delivery difference is the
  undeclared one.
- The archived `UPSTREAM-SWE-OVERLAY.md` (branch
  `cursor/hard-repo-tasks-5fc8`) covers a different, narrower upstream
  behavior (symptom strip/re-injection in `turn_scheduler_swe.py`) and is
  consistent with the pinned code; it says nothing about turn delivery, so
  it could not have caught this deviation.

### Recommendation

Move turn delivery harness-side to match upstream semantics: the eval loop
(or environment lifecycle, not an agent-visible tool) appends the next
user turn when the agent attempts to finalize or exhausts its per-turn
budget, and refuses final grading until all turns are delivered. If the
`advance()` tool is retained for infrastructure reasons, it must at
minimum (a) be invisible to the policy as a choice — i.e., called by the
scaffold, not the model — and (b) gate `_grade()` on
`index == len(turns) - 1`. Otherwise every evolved-arm result carries an
unmeasured "did the agent actually experience the evolution?" confound,
and the n_user_turns_delivered-style evidence upstream records
(`run_swe_mini_agent.py:224`) has no Parallax counterpart.

---

## Bottom line

1. **Arms**: upstream = two conditions, shared source IDs, aggregate means;
   turn-matched control only as a post-hoc appendix. Our three-arm paired
   design is an addition — sound, but sequence it: replicate the cheap
   two-condition screen first, add the matched arm and paired stats only
   where the screening delta reproduces.
2. **QC**: the field's admission bar is executable checks (gold must pass,
   no-op must fail) plus LLM-judges for semantic properties plus
   checklist-driven human review for specs. Parallax should put mechanical
   checks in code as blocking gates and encode the judgment-call review as
   a Cursor skill.
3. **Turn delivery**: upstream is harness-pushed and unskippable, graded by
   the official harness. Our agent-callable `advance()` is our deviation
   and should be redesigned (or fenced) before any evolved-arm result is
   interpreted.
