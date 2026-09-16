# Parallax pipelines: input → command → output

This document shows, start to finish, what actually happens when you use
Parallax today. Each walkthrough names the concrete input, the exact command
that exists in this repository, the artifacts that come out, and what you may
conclude from them. The theory lives in [`MODEL.md`](MODEL.md) and
[`RESEARCH-PROCESS.md`](RESEARCH-PROCESS.md); this page is only the
mechanics. Where something is designed but not built, it says so.

Three flows are implemented:

1. [Evolving Intent on GSM8K](#1-evolving-intent-on-gsm8k) — offline, free,
   copy-paste runnable right now.
2. [Evolving Intent on SWE-bench Verified](#2-evolving-intent-on-swe-bench-verified)
   — three paid stages already run once; real artifacts shown.
3. [Checkpoint evolution](#3-checkpoint-evolution-landing-in-pr-27) — offline
   slice landing in [PR #27](https://github.com/nikhil-vytla/hatch/pull/27).

The honest counterpart is [What is NOT automated yet](#what-is-not-automated-yet).

## 1. Evolving Intent on GSM8K

**What you start with.** One single-turn math problem. The offline fixture
`tests/fixtures/gsm8k.jsonl` holds GSM8K problem #1:

> Janet's ducks lay 16 eggs per day. She eats 3 for breakfast and bakes
> muffins with 4. She sells each remaining egg for $2. How many dollars does
> she make each day?

The `#### 18` answer is stripped from everything the agent sees and sealed as
grading authority.

**What you run.** From `parallax/`, after `uv sync`. The entry points are
`experiment.plan_experiment`, `experiment.execute`, and `findings.from_journal`;
the scripted construction model lives in `tests/conftest.py`. This snippet is
verified to run as-is:

```bash
uv run python - <<'PY'
import sys
sys.path.insert(0, "tests")
from pathlib import Path

from conftest import HistoryAgent, make_variants
from parallax.experiment import (
    CostRange, Execution, ExperimentConfig, execute, plan_experiment,
)
from parallax.findings import from_journal, render
from parallax.gsm8k import load_gsm8k, verify
from parallax.perturbation import Condition
from parallax.provider import Message

BASE, MATCHED, EVOLVED = map(Condition, ("base", "matched", "evolved"))
task = load_gsm8k(Path("tests/fixtures/gsm8k.jsonl"))[0]
variants, _ = make_variants(problem=task)
for condition in variants.conditions:
    turns = variants.variant(condition).turns
    print(f"--- {condition}: {len(turns)} turn(s) ---")
    for turn in turns:
        print(" ", turn.text)

agent = HistoryAgent()

def run(unit):
    prompts = variants.prompts(unit.condition)
    reply = agent(tuple(Message(role="user", content=t) for t in prompts), 64)
    return Execution(
        outcome=verify(task, reply),
        reported_model="offline-scripted-agent",
        prompt_tokens=1, completion_tokens=1, estimated_cost_usd=0.0,
    )

out = Path("/tmp/parallax-demo")
out.mkdir(exist_ok=True)
plan = plan_experiment(
    ((task, variants),),
    ExperimentConfig(
        model="offline-scripted-agent",
        conditions=(BASE, MATCHED, EVOLVED),
        trials=2,
        temperature=0.0,
        cost=CostRange(lower_per_episode_usd=0.0, upper_per_episode_usd=0.0),
    ),
)
execute(plan, run, journal_path=out / "evidence.jsonl", approve_spend=True)
print(render(from_journal(out / "evidence.jsonl", control=MATCHED, treatment=EVOLVED)))
PY
```

**What comes out.** First, the one source problem has become three conditions —
a single-turn baseline, a presentation-matched control that reveals one true
argument per turn, and an evolved route of the same length whose goal moves.
Real output, evolved condition truncated:

```text
--- base: 1 turn(s) ---
  I need help with calculate daily egg-sale revenue. Use eggs per day: 16.
  Use eggs eaten: 3. Use eggs baked: 4. Use price per egg: 2 dollars.
--- matched: 9 turn(s) ---
  I need help with calculate daily egg-sale revenue. Use eggs per day: 16.
  Use eggs eaten: 3.
  Use eggs baked: 4.
  ...same goal throughout; information only accumulates...
--- evolved: 9 turn(s) ---
  I need help with calculate eggs available to sell. Use price per egg: 3 dollars.
  Use eggs eaten: 2.
  Correction: change price per egg from 3 dollars to 2 dollars.
  ...
  My goal has changed from calculate eggs available to sell to calculate
  daily egg-sale revenue. Use the values from the conversation.
  Correction: change eggs per day from 12 to 16.
  Correction: change eggs baked from 5 to 4.
```

Note that `variants.prompts(condition)` is what the agent receives, and it is
the turn text plus the benchmark's submission contract. `Turn.text` alone is the
perturbation's material and would leave the agent guessing what the grader wants.

Second, `/tmp/parallax-demo/evidence.jsonl`: 7 canonical JSONL records — one
preregistered plan carrying the design digest, and six observations
(2 trials × 3 conditions). Third, the rendered findings. Real output:

```text
offline-scripted-agent @ e2b0f0ad6b41
  6/6 units | no run failures

  condition            pass   verified  wrong  invalid  failed
  base                  100%         2      0        0       0
  matched               100%         2      0        0       0
  evolved               100%         2      0        0       0

  evolved - matched: +0.000 [-1.000, +1.000] across 1 task cluster(s)
  the sample supports no effect smaller than 2.72; treat the sign as descriptive

  operating points: 0 informative of 3 task-conditions

  paid $0.00 this session; $0.00 recorded across all sessions
```

**What you can conclude.** With a history-reading scripted agent every condition
passes and the evolved-minus-matched difference is 0, but the interval spans
everything: one task cluster cannot support an effect smaller than 2.72, so the
sign is descriptive and nothing here is a finding. Swap `HistoryAgent` for
`LastMessageAgent` and the multi-turn conditions flip to `wrong`, which is the
mechanics of history sensitivity. Real experiments keep their evidence under
`research/<investigation>/evidence/`.

## 2. Evolving Intent on SWE-bench Verified

The same intervention on a real benchmark, with a real model (Claude Opus
4.8) and the official SWE-bench harness as sealed verifier. This flow has
three stages and each costs money; the recorded spends below are actuals.

### 2a. Screening: find boundary instances ($2.97)

**Start with:** the pinned SWE-bench Verified dataset (medium-difficulty
stratum). **Ran:** a bespoke driver in
`research/swebench-screening-round2-20260803/`, since deleted — it was one of
four hand-copied variations on the loop that `experiment.py` now owns, and its
summarizer had drifted to classifying operating points at `== 0`/`== 1` where
the package used `<= 0.1`/`>= 0.9`. The evidence it wrote is committed and
untouched; the driver is not reproducible under current code. **Out:**
`round2-report.json`, the canonical result and cost receipt. Real excerpt:

```json
{"actual_metered_cost_usd": 2.972512,
 "recommended_instances": ["swebench:astropy__astropy-14508",
   "swebench:django__django-13786", "swebench:pydata__xarray-4695"],
 "recommended_model": "claude-opus-4-8"}
```

**Conclude:** three instances sit at the 2/3 pass boundary — solvable but not
saturated, so an intent-evolution effect has room to show in either
direction. Details in
[`../research/swebench-screening-round2-20260803/README.md`](../research/swebench-screening-round2-20260803/README.md).

### 2b. Admission: gate the three instances (compute only)

Landed in [PR #25](https://github.com/nikhil-vytla/hatch/pull/25) with its own
driver, since deleted along with the rest. No inference — Docker only. Two gates
per instance now rather than six: an inert no-op patch must fail the official
tests, and the sealed gold patch must pass them. The four that were dropped
re-checked invariants that Pydantic validators or bundle compilation already
enforce, and one of them — the arm-completeness gate — is why every family had
to construct a third arm nobody ran. **Out:** `evidence/admission-summary.json`
and one `admission.json` per instance; all three admitted.

Those historical admission records no longer verify under current code, on
purpose: the task spec digest used to hash every arm's turn text, so retiring
one arm moved the identity of tasks whose own material never changed. Identity
is now scoped to the condition being run. See
[`../research/swebench-experiment-prerequisites-20260803/evidence/DIGEST-INVALIDATION.md`](../research/swebench-experiment-prerequisites-20260803/evidence/DIGEST-INVALIDATION.md).

### 2c. The experiment: single-turn vs evolved ($1.22)

**Start with:** an admitted instance's public issue text plus a
Haiku-constructed intent decomposition. Real construction record for
`django__django-13786` (from round-2 evidence):

```json
{"source": {"function": "squashmigrations",
  "arguments": [{"identifier": "migrations", "category": "context",
    "value": "[CreateModel(name='test_model', options={'verbose_name': 'Test'}), AlterModelOptions(name='test_model', options={})]"}]},
 "predecessors": [{"function": "CreateModel.reduce", "...": "..."}]}
```

The static arm delivers the raw issue in one 12-step phase. The evolved arm
splits the same 12 steps into two phases: first *"Work toward this
intermediate intent: CreateModel.reduce. … Do not implement the final issue
yet."*, then the harness interjects *"Hold on — before you finalize, the user
has new information…"* and delivers the full issue. The agent cannot skip or
reorder phases; the harness owns the schedule and grades a delivery receipt.

**Ran:** a driver in `research/swebench-single-vs-evolved-20260803/`, since
deleted; its `analyze_experiment.py` reimplemented the package's paired-bounds
math nearly line for line. **Out:** `evidence/experiment.jsonl` (18
units, all harness-verified), `evidence/experiment-report.json`, and spend
reconciliation. Real results:

| Instance | static | evolved |
|---|---|---|
| astropy__astropy-14508 | 2/3 | 1/3 |
| django__django-13786 | 3/3 | 3/3 |
| pydata__xarray-4695 | 0/3 | 0/3 |

**Conclude:** point estimate +0.111 for static-minus-evolved, but with 3
source clusters the minimum detectable effect is 1.568, so the interval is
the trivial [-1, 1]: the data neither advances nor rejects the hypothesis.
Unique metered spend was $1.219080. Both stages 2b and 2c land in
[PR #25](https://github.com/nikhil-vytla/hatch/pull/25) under
`research/swebench-experiment-prerequisites-20260803/` and
`research/swebench-single-vs-evolved-20260803/`.

Note one design gap stated plainly: this experiment compared base against
evolved only, so conversation length was not controlled for. Worse, the
`matched` arm that existed at the time would not have controlled for it — it
delivered the whole issue statement in both turns, so nothing accumulated,
while GSM8K's revealed one argument per turn as documented. Two adapters
implemented different semantics under one name and admission could not tell,
because it compared turn counts and per-turn budgets rather than what the turns
said. `intent_phases.py` now builds the control with GSM8K's semantics, and an
experiment opts into it when its sample can support the attribution.

## 3. Checkpoint evolution (landing in PR #27)

The second synthesis strategy, from
[SlopCodeBench](https://arxiv.org/abs/2603.24755): instead of one task whose
*intent* evolves across turns, one workspace persists across separately
scored checkpoints whose *requirements* accumulate. Everything below is on
the [PR #27](https://github.com/nikhil-vytla/hatch/pull/27) branch and still
in flux.

**Start with:** a hand-authored three-checkpoint family, `ce-tally-1`, in
`tests/fixtures/checkpoint_family.json` — a CLI tool built up in stages
(totals → top-name aggregation → file input) with 10 sealed
stdin/argv/exit-code cases. Real spec excerpt from checkpoint 1:

> Build a command-line tool whose entrypoint is `tally.py`, invoked as
> `python3 tally.py total`. … `total` prints the sum of all counts as a
> decimal integer followed by a single newline, then exits 0.

**Run** (offline, on the PR branch, from `parallax/`):

```bash
uv run python research/checkpoint-evolution-slice/make_seed_family.py  # rebuild fixture
uv run python -m pytest tests/test_checkpoint_runner.py -q             # both conditions end to end
uv run python research/checkpoint-evolution-slice/run_screening.py     # dry run + findings
```

**Out:** an `AdmissionReceipt` (two gates: incremental gold build and per-stage
no-op rejection; schema round-trip, completeness, and leakage were deleted
because the type system already makes those states unrepresentable), then a
journal written by the one experiment loop with two conditions — `evolved`
(the agent's own stage-N workspace feeds stage N+1, digest-chained) and
`carry-reference` (each stage starts from the frozen reference build). Each
stage is graded into a verdict vector: `strict_pass` (all accumulated
obligations, prior checkpoints re-run as regressions), `isolated_pass` (this
checkpoint's new cases only), `core_pass`.

**Conclude:** with scripted agents only, nothing yet about real models. What
the slice establishes is that skipped/reordered checkpoints, workspace-chain
drift, and answer leakage are structurally unrepresentable in the evidence.
Contract: [`methods/checkpoint-evolution.md`](methods/checkpoint-evolution.md);
trail: `research/checkpoint-evolution-slice/` (PR #27), including a
preregistration draft for the first paid run.

## What is NOT automated yet

- **No LLM-based synthesis of novel tasks from an arbitrary repository.**
  "Point Parallax at repo B and it invents checkpointed tasks" is
  aspirational, not implemented. Every implemented flow transforms an
  existing benchmark task; the checkpoint seed family is hand-authored. The
  designed-but-unbuilt synthesis pipeline (stages S1–S6, with its own
  admission gates) is specified in
  [`../research/slopcodebench-method/synthesis-workflow.md`](../research/slopcodebench-method/synthesis-workflow.md).
- **No one-command pilot.** Every paid run so far was driven by a bespoke
  script in its `research/` folder plus resume scripts written mid-incident;
  those are deleted and the loop they duplicated lives in `experiment.py`, but
  no packaged launcher replaces them. Analysis does have one entry point:
  `python -m parallax.findings JOURNAL`. Reproducing a historical paid flow
  still means reading that folder's `NOTES.md`.
- **GSM8K has never run against a real provider.** The full
  base/matched/evolved design is implemented and tested offline. The
  real-model SWE-bench experiment ran without a working control (see 2c).
- **Checkpoint evolution has no paid run beyond screening.** Estimands and
  decisions are deferred to its preregistration draft. Analysis is no longer
  a gap: it shares `findings.py` with every other flow.
