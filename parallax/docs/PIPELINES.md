# Parallax pipelines: input, command, output

What actually happens when you use Parallax today. Each walkthrough names the
concrete input, the exact command that exists in this repository, the artifacts
that come out, and what you may conclude from them. Theory lives in
[`MODEL.md`](MODEL.md) and [`RESEARCH-PROCESS.md`](RESEARCH-PROCESS.md); results
live in [`FINDINGS.md`](FINDINGS.md). This page is only the mechanics. Where
something is designed but not built, it says so.

Three flows are implemented:

1. [Evolving Intent on GSM8K](#1-evolving-intent-on-gsm8k). Offline, free,
   copy-paste runnable right now.
2. [Evolving Intent on SWE-bench Verified](#2-evolving-intent-on-swe-bench-verified).
   Three paid stages, already run once, with the real artifacts shown.
3. [Checkpoint evolution](#3-checkpoint-evolution-028). One family, two arms,
   one paid screening run whose result is not what it looks like.

Then [what is not automated yet](#what-is-not-automated-yet), which is the part
worth reading before you believe any of the above scales.

## 1. Evolving Intent on GSM8K

**What you start with.** One single-turn math problem. The offline fixture
`tests/fixtures/gsm8k.jsonl` holds GSM8K problem #1:

> Janet's ducks lay 16 eggs per day. She eats 3 for breakfast and bakes
> muffins with 4. She sells each remaining egg for \$2. How many dollars does
> she make each day?

The `#### 18` answer is stripped from everything the agent sees and sealed as
grading authority.

**What you run.** From `parallax/`, after `uv sync`. There is no CLI; the
entry points are `runner.run_experiment` and `report.report_from_jsonl`, and
the scripted construction model lives in `tests/conftest.py`. This snippet is
verified to run as-is:

```bash
uv run python - <<'PY'
import sys
sys.path.insert(0, "tests")
from pathlib import Path

from conftest import HistoryAgent, make_family
from parallax.report import report_from_jsonl
from parallax.runner import run_experiment

family, _ = make_family()
for script in family.scripts:
    print(f"--- {script.arm}: {len(script.turns)} turn(s) ---")
    for turn in script.turns:
        print(" ", turn.text)

out = Path("/tmp/parallax-demo")
out.mkdir(exist_ok=True)
run_experiment(
    (family,),
    lambda source_id, arm, seed: HistoryAgent(),
    trial_seeds=(11, 12),
    agent_model="offline-scripted-agent",
    model_config={"provider": "scripted", "temperature": 0},
    threshold=0.1,
    output_path=out / "evidence.jsonl",
)
report = report_from_jsonl(out / "evidence.jsonl", out / "report.json")
print({key: report[key] for key in ("difference", "identification_bounds", "action")})
PY
```

**What comes out.** First, the one source problem has become three arms: a
single-turn baseline plus two nine-turn scripts that differ only in whether the
intent evolves. Real output, evolved arm truncated:

```text
--- static: 1 turn(s) ---
  I need help with calculate daily egg-sale revenue. Use eggs per day: 16.
  Use eggs eaten: 3. Use eggs baked: 4. Use price per egg: 2 dollars.
--- matched: 9 turn(s) ---
  I need help with calculate daily egg-sale revenue. Use eggs per day: 16.
  Use eggs eaten: 3.
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

Second, `/tmp/parallax-demo/evidence.jsonl`: 8 canonical JSONL records. One
preregistered manifest, one family record (the only place the sealed `18`
appears), and six run records (2 trials × 3 arms). A real run row, trimmed:

```json
{"arm": "evolved", "final_answer": "FINAL_ANSWER: 18", "kind": "run",
 "outcome": {"kind": "verification", "verdict": "pass",
             "reason": "final answer matches source authority"}}
```

Third, `/tmp/parallax-demo/report.json`. Real output:

```text
{'difference': 0.0, 'identification_bounds': {'lower': 0.0, 'upper': 0.0},
 'action': 'inconclusive'}
```

**What you can conclude.** With a history-reading scripted agent every arm
passes, the matched-vs-evolved difference is 0, and the report still refuses a
decision: one source cluster is far below the power gate, so `action` is
`inconclusive` by design. Swap `HistoryAgent` for `LastMessageAgent` and the
multi-turn arms flip to `wrong`, which is history sensitivity in its crudest
form, shown in `tests/test_end_to_end.py`. Nothing here is evidence about real
models. What it demonstrates is what the harness records. Real experiments keep
their evidence under `research/<investigation>/evidence/`.

## 2. Evolving Intent on SWE-bench Verified

The same intervention on a real benchmark, with a real model (Claude Opus
4.8) and the official SWE-bench harness as sealed verifier. This flow has
three stages and each costs money; the recorded spends below are actuals.

### 2a. Screening: find boundary instances (\$2.97)

**Start with:** the pinned SWE-bench Verified dataset (medium-difficulty
stratum). **Run:** the bespoke driver
`research/swebench-screening-round2-20260803/run_screening.py` (requires
`HUD_API_KEY`, local Docker with `DOCKER_DEFAULT_PLATFORM=linux/amd64`, and
`uv run --with pyarrow`; follow-up census drivers sit alongside it).
**Out:** `round2-report.json`, the canonical result and cost receipt. Real
excerpt:

```json
{"actual_metered_cost_usd": 2.972512,
 "recommended_instances": ["swebench:astropy__astropy-14508",
   "swebench:django__django-13786", "swebench:pydata__xarray-4695"],
 "recommended_model": "claude-opus-4-8"}
```

**Conclude:** three instances sit at the 2/3 pass boundary, solvable but not
saturated, so an intent-evolution effect has room to show in either direction.
Details in
[`../research/swebench-screening-round2-20260803/README.md`](../research/swebench-screening-round2-20260803/README.md).

### 2b. Admission: gate the three instances (compute only)

Landing in [PR #25](https://github.com/nikhil-vytla/hatch/pull/25). **Run:**

```bash
DOCKER_DEFAULT_PLATFORM=linux/amd64 uv run --with pyarrow python \
  research/swebench-experiment-prerequisites-20260803/run_admission.py
```

No inference, Docker only. Six gates per instance, including: the compiled
agent bundle contains no sealed bytes, an inert no-op patch must fail the
official tests, and the sealed gold patch must pass them. **Out:**
`evidence/admission-summary.json` and one `admission.json` per instance; all
three admitted. The same folder preregisters the 18-unit experiment design
(digest `e230043c…`) before any paid unit runs.

### 2c. The experiment: single-turn vs evolved (\$1.22)

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
yet."*, then the harness interjects *"Hold on, before you finalize, the user
has new information…"* and delivers the full issue. The agent cannot skip or
reorder phases; the harness owns the schedule and grades a delivery receipt.

**Run:** `research/swebench-single-vs-evolved-20260803/run_experiment.py`
(same environment as screening). **Out:** `evidence/experiment.jsonl` (18
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
Unique metered spend was \$1.219080. Both stages 2b and 2c land in
[PR #25](https://github.com/nikhil-vytla/hatch/pull/25) under
`research/swebench-experiment-prerequisites-20260803/` and
`research/swebench-single-vs-evolved-20260803/`. Note one design gap stated
plainly: this experiment compared static against evolved only. The
turn-matched control arm that the GSM8K design treats as mandatory was not
part of the 18-unit design, so conversation length is not yet controlled for
on SWE-bench.

## 3. Checkpoint evolution (\$0.28)

The second synthesis strategy, from
[SlopCodeBench](https://arxiv.org/abs/2603.24755): instead of one task whose
*intent* evolves across turns, one workspace persists across separately
scored checkpoints whose *requirements* accumulate. Merged in
[PR #27](https://github.com/nikhil-vytla/hatch/pull/27), with one paid
screening run behind it.

**Start with:** a hand-authored three-checkpoint family, `ce-tally-1`, in
`tests/fixtures/checkpoint_family.json`, a CLI tool built up in stages
(totals → top-name aggregation → file input) with 10 sealed
stdin/argv/exit-code cases. Real spec excerpt from checkpoint 1:

> Build a command-line tool whose entrypoint is `tally.py`, invoked as
> `python3 tally.py total`. … `total` prints the sum of all counts as a
> decimal integer followed by a single newline, then exits 0.

**Run** (from `parallax/`; the first two are offline and free, the third spends
money):

```bash
uv run python research/checkpoint-evolution-slice/make_seed_family.py  # rebuild fixture; 5 admission gates
uv run python -m pytest tests/test_checkpoint_runner.py -q             # both arms end to end
uv run python research/checkpoint-evolution-slice/run_screening.py     # offline dry run; add --live --approve-spend to pay
```

**Out:** an `AdmissionReceipt` (five gates: schema round-trip, completeness,
leakage, incremental gold build, per-stage no-op rejection), then evidence
JSONL from `checkpoint_runner.run_ce_experiment` with two arms, `evolved`
(the agent's own stage-N workspace feeds stage N+1, digest-chained) and
`carry-reference` (each stage starts from the frozen reference build). Each
stage is graded into a verdict vector: `strict_pass` (all accumulated
obligations, prior checkpoints re-run as regressions), `isolated_pass` (this
checkpoint's new cases only), `core_pass`.

**Conclude:** the slice establishes that skipped or reordered checkpoints,
workspace-chain drift, and answer leakage are structurally unrepresentable in
the evidence. The live run added 60 Haiku 4.5 stage calls for \$0.28 and split
the arms completely at stage 3, but on the declared byte cap rather than on any
verdict, so it says nothing yet about verification decay. Read
[`FINDINGS.md`](FINDINGS.md#what-the-checkpoint-evolution-screening-measured-and-what-it-does-not-license)
before quoting that number. Contract:
[`methods/checkpoint-evolution.md`](methods/checkpoint-evolution.md); trail:
[`../research/checkpoint-evolution-slice/`](../research/checkpoint-evolution-slice/README.md),
including the preregistration and the screening report.

## What is NOT automated yet

- **No LLM-based synthesis of novel tasks from an arbitrary repository.**
  "Point Parallax at repo B and it invents checkpointed tasks" is
  aspirational, not implemented. Every implemented flow transforms an
  existing benchmark task; the checkpoint seed family is hand-authored. The
  designed-but-unbuilt synthesis pipeline (stages S1–S6, with its own
  admission gates) is specified in
  [`../research/slopcodebench-method/synthesis-workflow.md`](../research/slopcodebench-method/synthesis-workflow.md).
- **No one-command pilot and no CLI.** Each paid run so far was driven by a
  bespoke script in its `research/` folder (`run_screening.py`,
  `run_admission.py`, `run_experiment.py`), plus resume scripts written
  mid-incident. Reproducing a paid flow means reading that folder's
  `NOTES.md`, not invoking a stable tool.
- **GSM8K has never run against a real provider.** The full
  static/matched/evolved design is implemented and tested offline, but all
  GSM8K evidence uses scripted agents. Conversely, the real-model SWE-bench
  experiment lacks the matched control (see 2c). No single flow yet has both
  the complete design and real-model evidence. That is the current gap
  between what the docs describe and what has been measured.
- **Checkpoint evolution has no report module.** Admission, two arms, evidence,
  and one paid screening run exist. The stage-indexed and slope estimands do
  not, so every CE number so far is descriptive.
- **The checkpoint byte budget is unsettled.** The one paid CE run failed the
  evolved arm 10/10 on a 4096-byte reply cap we chose, which means the cap and
  the full-file-map reply format are confounded with the effect the method is
  about. A variant run is what fixes this, not a doc edit.
