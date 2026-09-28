# NOTES: upstream design audit

Working notes for three questions about what the upstream papers/codebases
actually do versus what Parallax layered on top. Primary sources:

- microsoft/evolving-intent at pinned commit
  `993d6be9597ac03854b46362ccd647eb1bfd267a` (HEAD of the public repo as of
  2026-08-02; verified `git rev-parse HEAD` == pin). Clone: `/tmp/evolving-intent`.
- SprocketLab/slop-code-bench at `8e3a8b6` (HEAD as of 2026-08-02; the
  checkpoint-evolution doc pins `8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b`,
  which is this commit). Clone: `/tmp/slop-code-bench`.
- Paper "LLMs Get Lost in Evolving User Intent", arXiv:2607.20734 (exact ID
  confirmed from repo README badge + citation block).
- Paper "SlopCodeBench", arXiv:2603.24755 (v2 abstract: 36 problems / 196
  checkpoints; v1: 20 problems / 93 checkpoints).
- Local: parallax/docs/methods/evolving-intent.md, checkpoint-evolution.md,
  MODEL.md, docs/decisions/, and the archived UPSTREAM-SWE-OVERLAY.md from
  branch cursor/hard-repo-tasks-5fc8.

## Setup log

- Main checkout at /Users/nikhil/work/hatch is on someone else's branch
  (parallax/spec-translation) and was left untouched. Created worktree
  /tmp/hatch-upstream-audit on new branch `research/upstream-design-audit`
  from origin/main.
- Cloned both upstream repos read-only into /tmp. evolving-intent HEAD ==
  pinned 993d6be, so all reads are at the pin.

## Q1: experimental arms in the upstream evaluation

### What the repo actually does

- `evaluation/runners/run_experiment.py` infers a *scenario* from
  (num_turns, num_revisions, num_switches): `fully_specified` (t=1),
  `under_specified` (t>1, no changes), `argument_revision`,
  `function_switch`, `combined` (lines 87-99). Each scenario is a separate
  run writing one results JSON keyed by task_id; the summary is aggregate
  accuracy = correct/total (lines 768-828). No pairing logic, no per-source
  contrast, no uncertainty computation anywhere in the repo. `rg` for
  ttest/wilcoxon/bootstrap/scipy/mcnemar/p-value across all .py files finds
  nothing (only docstring word matches like "paired_g1_n251.json", a data
  filename).
- Same-source comparability is achieved *by subset selection, not pairing*:
  `--task_ids_file` ("JSON file with task_ids to filter (for fair
  comparison)", run_experiment.py:928-929) points at fixed eval-index files
  (`intent_construction/eval_indices/*_task_ids.json`) so every scenario
  runs the same source IDs. Comparison across scenarios is post-hoc, read
  the two JSONs, compare mean accuracies.
- Published eval scripts (`evaluation/scripts/run_gsm8k.sh:37-41`,
  `run_swe.sh:46-49`) run exactly TWO conditions per model:
  `single` (t=1,p=0,g=0) and `evolve` (t=7,p=2,g=2). No turn-matched arm in
  the published scripts. The `--run_plan` sweep (run_experiment.py:974-988)
  covers 25 configs including under_specified t=2/4/8. That's the closest
  thing to a turn-matched condition, and it's a *scenario in a sweep*, not a
  paired control.
- Budget confound, SWE: run_swe.sh gives `single` step_limit 100/turn (1
  turn) and `evolve` 200 steps/turn × 7 turns (lines 16-17, 35-37). The
  paper (§5, experimental setup) says per-turn tool-call budget 100, raised
  to 200 for two models that hit limits. Either way the evolve arm gets
  more total steps than single. Upstream does NOT budget-match arms.

### What the paper does

- Main result (Table 1): Single vs Evolve accuracy per model per dataset,
  with relative-change percentages in parentheses and background color for
  degradation. Means only; no error bars, no statistical tests, no paired
  analysis mentioned anywhere.
- §5.2 ablations (Table 2, Figs 4-5): more mean tables across transition
  counts/compositions/orders.
- Turn-matched control EXISTS but only as appendix F.4: "we construct
  turn-matched controls that vary the number of turns while controlling the
  underlying intent dynamics. To this end, we repeat the turn... making no
  intent change while increasing the number of turns... adding more turns
  without intent changes does not reduce performance." Reported as Table 5,
  means only. Note their turn-matched construction = repeat previous turn
  (restatement), similar in spirit to Parallax's matched arm's "restate
  continuity" turns.
- Also F.5: preliminary GRPO training experiment (Qwen3-4B 64→76 on evolved
  GSM8K).
- Sample sizes: GSM8K 200, BIRD 100, BrowseComp+ 100, SWE 50, sampled
  randomly from the verified pool "for cost-effective evaluation" (App. B,
  Filtering and sampling).

### slop-code-bench

- Evaluation = run agent through checkpoints, report solve rates
  (strict/isolated/core), degradation percentages (erosion up in 77% of
  trajectories), medians and per-checkpoint slopes vs a 473-repo human
  panel, and a prompt-intervention study. Descriptive statistics; no
  hypothesis tests found in src/ (rg for stats terms: no hits in code).
  There are no "arms" at all in the Parallax sense. It's a benchmark, one
  condition per (agent, prompt-config).

### Verdict for Q1 (draft)

Upstream = generate + measure aggregate deltas on a shared source subset.
Parallax's three-arm paired design with preregistered units, paired
Hoeffding intervals etc. (methods/evolving-intent.md "Controlled
comparison"; GSM8K slice choices) is OUR addition. The paper's own
comparison answers "does accuracy drop?" but cannot attribute the drop to
intent evolution vs turn count vs budget (their F.4 partially covers turn
count, post-hoc, appendix-level; budget is explicitly unequal in SWE).
Recommendation drafted in README: replicate upstream's two-condition
aggregate comparison first as a cheap screening gate (it IS the paper's
design), keep the matched arm as the first *add-on* rather than a
launch blocker; the full three-arm paired machinery is warranted only once
the screening delta reproduces.

## Q2: QC / admission practices

### evolving-intent (actual code)

Construction-time, all stages, mostly LLM-based with execution/answer
anchoring:
- Extraction: coverage check (LLM; App. D.1 "prevents cases where the
  extractor produces an under-specified version") + solvability check
  (reference solver must produce same answer for rendered intent and
  original question, or match gold; App. D.1; GSM8kVerifier.verify_solvability,
  dataset_impl/gsm8k/verifier.py:44-74, num_runs majority).
- Counterfactuals: LLM verifier accepts only minimal localized value
  substitution; rejects additive/deletive edits; bounded length ratio
  (App. D.2).
- Predecessors: LLM judge for function validity (related but not same
  quantity); answer-preservation via reference solver (augmented intent must
  not change final answer); cross-turn independence for chains (App. D.3;
  generate_predecessors.py:518-651 `_verify_functional_independence`,
  majority of independence_runs=3, max 2 feedback-based retries).
- Naturalizer validation: critical-token extraction (numbers, entities,
  quoted strings) checked against rule-based reference; retry then fall
  back to rule-based turn (App. C / naturalizer).
- Post-hoc pool filter: `evaluation/scripts/filter_valid_samples.py`,
  intersection of quality flags (verification_passed AND
  independence_passed) and *simulation viability across all 23 eval
  configs* (sample must have enough arguments/functions for every config).
- Eval-time: BIRD-SQL LLM-judge lenient re-grading (llm_judge_bird_sql.py,
  invoked from run_experiment.py:736-766); SWE graded by official harness.
- `retry_failed.py` scripts at extraction/counterfactual/predecessor stages.
- NO human review step anywhere in the pipeline.

### slop-code-bench

- Human review checklists: docs/contributing-problems/checklist.md (design,
  leakage, ambiguity: "Could two correct implementations produce different
  outputs?") and review-checklist.md (~70 concrete config/spec/test items,
  incl. leakage section, language-agnosticity, error-message
  non-prescription).
- Automated structural checks: `slop-code problems status` (tests/ exists,
  conftest, no legacy loader/verifier, per-checkpoint test file + solution
  dir + spec).
- Reference solutions exist per checkpoint (solutions/checkpoint_N/) but
  KNOWN_ISSUES.md admits several reference solutions fail their own tests;
  they "prioritized test case accuracy over fixing all reference
  solutions", meaning reference-solution verification is aspirational and the
  tests are the ground truth.
- Paper §2 Problem Construction: authors drafted problems; each reviewed by
  ≥1 other author; proposal-phase culling (not design-testing or one-shot
  solvable); validation phase = write tests + attempt each checkpoint with
  an agent to find ambiguous/under-specified cases; final review pass for
  solvability-in-principle and spec/test match.

### Other efforts surveyed

- SWE-smith (arXiv:2504.21798, NeurIPS 2025): execution-based validation,
  apply candidate bug patch, run suite, keep only if ≥1 previously passing
  test breaks (F2P), discard if runtime >2min. Problem statements
  LLM-generated; paper admits no checks for under-specified text or
  solution leakage; not suitable for evaluation (no hidden tests). ~7-8 min
  human labor per repo (install parsing, output parser).
- SWE-Gym (arXiv:2412.21139): real PRs + executable environments; human +
  execution validation to configure environments (see search notes).
- Prime Intellect Environments Hub / research-environments: strongest
  operational QC found. No-op validation (tests must FAIL with zero
  edits), gold-patch validation (reference fix must pass, up to 10×
  retries to separate flaky from broken), independent second passes,
  debug CLI, verified re-uploads with every exclusion persisted for audit.
  `uv run validate` = model-free gold + no-op checks.
- Self-Instruct (arXiv:2212.10560): heuristic + similarity filtering,
  ROUGE-L <0.7 vs pool, keyword blacklist (image/picture/graph), length and
  format heuristics; no execution. (From memory of the paper; standard.)
- Evolving-intent itself doubles as the LLM-judge-validation exemplar
  (counterfactual/predecessor judges) alongside BIRD LLM-judge grading.

### Classification table (draft in README)

automated structural | execution-based | LLM-judge | human review,
each effort classified; see README.

## Q3: upstream turn delivery + SWE harness

Definitive, at pinned commit 993d6be:

- Turns are pre-scripted by the simulator BEFORE the agent runs.
  run_swe_mini_agent.py:104 `"_user_turns": [t["content"] for t in gs.turns
  if t.get("role")=="user"]`, so the mini-agent "receives the multi-turn
  script verbatim" (comment at :92-94).
- Delivery is harness-side interception, not an agent-callable tool:
  swe_minisweagent_scaffold.py module docstring (lines 6-25): "Strategy:
  drive agent.step() ourselves. Whenever the agent tries to submit (raises
  Submitted) but we still have undelivered user turns, we *intercept* the
  submission, append the next user turn as a follow-up message, and resume.
  Only when the agent submits AFTER all user turns are delivered do we
  accept the patch as final."
  Code: run loop lines 710-749 (`except Submitted` → if delivered <
  len(user_turns): synthesize tool-result fillers, `_wrap_intent_update`
  ("Hold on, before you finalize, the user has new information... Do not
  submit yet unless this update has been fully incorporated", lines
  408-424), append, continue; else accept).
- Second trigger: per-turn step exhaustion. `except LimitsExceeded` lines
  750-787: if not cost-capped and turns remain, advance to next intent turn
  and re-arm per-turn budget; terminal only on final turn/cost cap, then
  autosubmit via git diff (lines 853-869).
- Can the agent skip ahead? NO mechanism exists to request/skip turns. The
  agent influences *timing* only (submitting early pulls the next turn
  immediately), but every scripted turn is force-delivered before a final
  submission is accepted; there is no tool in the agent's toolset for turn
  control (only BASH_TOOL, lines 74, 264). The agent cannot terminate the
  episode early: an early submit is converted into the next user turn.
- Generic (non-SWE) runner is likewise harness-side: run_experiment.py
  run_multi_turn_conversation lines 281-348, a loop of sample.reset() /
  model call / sample.step(response) / sample.is_done(); simulator
  user_simulation.py step() (961-1023) just returns the next pre-built or
  naturalized turn; is_done() (1025-1027) = cursor past end. The model
  response content does not gate delivery (except as naturalizer context).
- Grading: official SWE-bench harness. swe_harness.py docstring line 4
  ("wrapper around the official `swebench` library"), line 234
  `from swebench.harness.run_evaluation import main as swebench_main`,
  invoked at lines 273-288 with dataset princeton-nlp/SWE-bench_Verified
  (line 50), namespace "swebench" (line 131 canonical leaderboard images).
  Runner: run_swe_mini_agent.py:180-197 harness.verify_patch → resolved.
- Paper cross-check (§5 experimental setup): "extended to multi-turn by
  intercepting the agent's submission and injecting the next scripted user
  turn until the script is exhausted, with a per-turn tool-call budget of
  100."
- Conclusion: Parallax's agent-callable, agent-defeatable `advance()` tool
  is a Parallax deviation, not upstream parity. Upstream turn delivery is
  eval-loop-owned and unskippable.
- The archived UPSTREAM-SWE-OVERLAY.md (branch cursor/hard-repo-tasks-5fc8)
  covers a different, narrower topic (symptom strip/re-inject in
  turn_scheduler_swe.py) and is consistent with what I see at the pin.

## Parallax-side grounding (added after reading src)

- `advance(token)` lives at parallax/src/parallax/swebench_env.py:112-124,
  registered as a FastMCP tool on the in-container "turn director"
  (`_director`, line 31; capability added at 133-148). Pull model: the
  agent calls it to get the next turn + step budget. Nothing gates
  `_grade()` (lines 64-109) on all turns having been delivered, so an agent
  can submit at turn 0 or drain all turns instantly.
- Parallax SWE grading runs the sealed test patch + pinned test command
  inside the official image (swebench_env.py:48-109), not
  swebench.harness.run_evaluation. This difference is declared in
  methods/evolving-intent.md; the advance() pull-model difference is not.

## Misc observations

- evolving-intent seeds: predecessor generator uses unseeded random and
  completion-order pools (already documented in
  parallax/docs/methods/evolving-intent.md "Interpretation and limits");
  confirmed the eval side also has no seed plumbing for scheduling beyond
  data order.
- SWE evolve arm in upstream uses `--use_tool_calling` (native) with output
  suffix native_tool200; single-turn baseline documented as "validated 64%
  native baseline" (run_swe_mini_agent.py:253, 267).
