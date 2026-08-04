# GSM8K Evolving Intent against a real provider

This closes the oldest open gap in Parallax. Every GSM8K run before this one
used scripted agents, which `docs/RESEARCH-PROCESS.md` recorded as a standing
TODO under "Deliberately out of scope → Real-model evidence". The harness now
has real-model evidence: 144 GSM8K source tasks, three arms, three trials,
1,296 graded episodes against Claude Haiku 4.5 through the HUD gateway, for
$10.96 in metered tokens.

The headline is that going live broke five things that offline testing could
not see, and that the measured effect decomposes cleanly once it does run.

## Results

144 source clusters, 3 trials, 1,296 scheduled episodes, **zero run failures**.
Accuracy is the mean over sources of each source's mean pass rate; intervals are
95% percentile bootstrap over source clusters (20,000 resamples, seed
20260803).

| arm | passed | accuracy | 95% CI | wrong | invalid | run failures |
|---|---|---|---|---|---|---|
| base (static), 1 turn | 311/432 | 0.720 | [0.648, 0.789] | 121 | 0 | 0 |
| matched, ~8.6 turns | 274/432 | 0.634 | [0.563, 0.704] | 158 | 0 | 0 |
| evolved, ~8.6 turns | 264/432 | 0.611 | [0.539, 0.683] | 164 | 4 | 0 |

Paired contrasts, differenced within (source, trial) and clustered by source:

| contrast | estimate | 95% bootstrap | 95% normal | SE | pairs dropped |
|---|---|---|---|---|---|
| **evolved − base (primary)** | **−0.109** | **[−0.160, −0.060]** | [−0.160, −0.058] | 0.026 | 0 |
| matched − base (secondary) | −0.086 | [−0.130, −0.044] | [−0.129, −0.042] | 0.022 | 0 |
| evolved − matched (secondary) | −0.023 | [−0.081, +0.035] | [−0.080, +0.034] | 0.029 | 0 |

Read as facts, not as a verdict: presenting the same verifiable GSM8K task
through an evolving intent trajectory rather than a single fully-revealed turn
costs Haiku 4.5 about 10.9 accuracy points, with a 95% interval from 6.0 to
16.0 points. No run failures means the identification bounds coincide exactly
with the point estimates, so nothing here rests on how missing outcomes were
handled.

Because all three arms ran, the primary gap decomposes:

- −8.6 points come from multi-turn progressive presentation alone. The matched
  arm never changes the goal and never corrects a value; it only reveals the
  same source intent one argument at a time. That alone accounts for about
  four fifths of the total gap.
- −2.3 points remain for intent evolution on top of multi-turn presentation,
  and that interval spans zero.

So at this sample, most of what looks like "lost in evolving intent" on GSM8K
is the cost of spreading a request over turns, not the cost of the intent
evolving. That is a more specific claim than the single-turn comparison alone
supports, and it is the last thing the matched arm will be used for.

### Turn delivery

Every scheduled turn was delivered and answered in every episode: 432/432
episodes complete in all three arms, 432 assistant turns for base and 3,708
each for matched and evolved. Matched and evolved having byte-identical turn
totals is the budget-matching invariant holding in practice. The 7,848 episode
turns equal the 7,848 metered episode calls exactly, so every turn produced
exactly one provider call with no silent retry or dropped turn.

### The four invalid submissions

All four are in the evolved arm, all the same mode: the model ended its final
reply asking a clarifying question and omitted the `FINAL_ANSWER` line
altogether, because a late correction left it believing a value was still
missing (for example an argument revised to "60% of [base amount]"). The grader
counts these against the model, which is the documented behavior. At 4/432 they
do not move any interval, but the asymmetry is real: only the evolved
trajectory induced format non-compliance.

## The three-arm design is being retired

Future runs use two arms, base versus evolved. Full rationale and the
preregistration amendment are in
[`PREREGISTRATION-AMENDMENT.md`](PREREGISTRATION-AMENDMENT.md). Short version:
the matched arm exists to license one attribution, and it is only worth its cost
when the sample can support that attribution. Measured here, evolved − matched
has the largest standard error of the three contrasts (0.029), the widest
interval (0.116 wide), the smallest point estimate (−0.023), and is the only one
whose interval spans zero. It consumed roughly 45% of the episode budget to
produce the least informative number in the study.

The tradeoff is worth stating rather than glossing: the matched arm is exactly
what produced the decomposition above. A two-arm design measures the total gap
and cannot split it. Retiring the arm buys episode budget and gives up that
split.

The instruction to retire it arrived after construction finished and before any
episode ran. Because constructing the matched script is free — `_matched_turns()`
renders locally off the already-extracted source intent and makes no provider
calls — dropping it would have saved nothing already spent, and two-arm
*execution* would have required breaking the three-arm pin in
`ScriptFamily.controlled_arms`, `_build_manifest`,
`ManifestRecord.unique_design_units`, and `run_experiment`, colliding with a
concurrent restructure of exactly that pin. The arm was executed, and is
reported as secondary.

## What the live run broke that offline testing missed

This is the reason the unit existed. Five defects, none of which the 124-test
offline suite could reach, because scripted agents satisfy contracts that real
models do not. The first three would each have invalidated the entire
experiment.

**1. No submission contract ever reached the agent.** `run_script` built the
transcript from `Turn.text` alone, with no system message. But `gsm8k.grade`
requires the final non-empty line to be `FINAL_ANSWER: <integer>` with exactly
one marker. Nothing ever told a real model that. Asked a rendered intent turn,
Haiku replied in Markdown prose ending `**Total clips sold:** ... **72 clips**`
— graded `invalid`. Every episode in all three arms would have scored invalid
and the run would have measured prompt formatting instead of intent evolution.
The offline agents pass because `conftest.HistoryAgent` returns
`f"FINAL_ANSWER: {...}"` by construction. Fixed: `run_script` and
`run_experiment` take an optional `system_prompt`, prepended to the transcript
so it is both sent and retained in evidence, byte-identical across arms so it
cannot confound the contrast.

**2. Construction prompts never stated their output schema.** The stage prompt
was `parallax-stage:extract-intent\nReturn one strict JSON object.` Haiku
answered with `{"intent": ..., "problem_type": ..., "given_information": {...}}`
— nothing like the required `{"function", "arguments"}`. Offline stubs return
the right shape by construction, so the prompt was never under test. Fixed: each
stage states its exact schema. After the fix, **0 of 834 construction attempts
were rejected** across the 144 admitted families.

**3. The GSM8K construction parser had no fence tolerance.** `_parse_model`
called `model_validate_json(output)` directly, and Haiku wraps JSON in
```` ```json ```` fences. `swebench.py:417` had already learned this and strips
fences; the GSM8K path never got the fix. Fixed with a shared `_unfence` helper,
tolerant of bare and `json`-tagged fences in either case, that leaves the raw
provider bytes intact in the retained `GenerationAttempt.output`.

**4. The packaged loader cannot load the official GSM8K test split.**
`load_gsm8k` aborts the whole file on the first sealed answer that is not a
canonical integer, and 14 of the 1,319 official rows write their answer with a
thousands separator (`#### 2,125`). Deliberately **not fixed here**:
`validate_answer` is shared by sealed-source parsing and model-submission
grading, so loosening it would change grading authority semantics inside a PR
whose job is the live run. Those 14 rows (1.1%) are declared out of population
instead, applied before construction and identically for every arm. Recommended
follow-up: a dataset-adapter normalisation on the sealed answer at ingestion,
leaving submission grading strictly canonical.

**5. Construction stage budgets are hardcoded and too tight.**
`build_script_family` passes literal budgets to its stages — 256 tokens for
`extract-intent`, 128 for each other stage — and its `max_output_tokens`
parameter sizes only *episode* turns, not construction. Three of 150 sources
lost construction to `BudgetError` when Haiku's extraction JSON exceeded 256
tokens. Not fixed here: raising it mid-run would have changed construction for
every source after the design was digest-bound.

A sixth defect was in this study's own driver rather than the package: the
resume path crashed on first use, because `ScriptFamily.model_validate(dict)`
fails under `StrictModel`'s `strict=True` (a JSON list will not coerce into a
declared `tuple` field). Only a crash reaches that path, so the single-pass
pilot never exercised it. A seventh was in the analysis: the source-clustered
bootstrap resamples by index, and building its cluster list in dict-insertion
order made the reported interval depend on the order rows appeared in the
evidence file, violating the repo's byte-stability requirement. Clusters are now
sorted by source id, and `verify_analysis.py` checks invariance under four row
shuffles.

## Seeds are recorded but not causally wired

Preregistering per-trial seeds as if they controlled sampling would have been a
fiction, so it was measured first. Results in
[`evidence/gateway-probe.json`](evidence/gateway-probe.json):

- **Temperature is causally real.** Three calls at `temperature=1.0` with one
  identical prompt returned `7382`, `7284`, `7382`.
- **`seed` is accepted and silently ignored.** The gateway does not reject the
  OpenAI-style `seed` field, but two calls with `seed=12345` at temperature 1.0
  returned `7482` and `7392` — different completions, same seed.

So `provider.text_completion` now forwards both `temperature` and `seed` (the
field was previously dropped entirely, with temperature defaulting to 0.0), and
the seed genuinely reaches the wire, but **this provider does not honour it**.
The three trials are independent samples at temperature 1.0, not
seed-reproducible replicates. The construction seed *is* causal: it drives the
local event scheduler in `evolving_intent._schedule_events`.

## Design

Preregistered in [`preregistration.json`](preregistration.json), digest
`b2d987241252a19845ad5d0724e926109e6ad867d49474aeee473b1d6b6eff86`, written
before the main run's first paid call and amended for reporting emphasis only in
[`PREREGISTRATION-AMENDMENT.md`](PREREGISTRATION-AMENDMENT.md).

- **Sources.** Official `openai/grade-school-math` test split, SHA-256
  `3730d312…c39d14`, 1,319 rows, 1,305 admissible. Selection: sort by id, drop
  the four calibration-pilot sources, one seeded shuffle, take 150. A single
  shuffle rather than `random.sample`, because `sample` is not prefix-stable
  across sizes and so cannot carve disjoint pilot and main samples from one
  seed.
- **Admission.** Construction must succeed, and at most 6 extracted arguments
  (each argument costs two turns, so this caps episodes at 13 turns). 144 of 150
  admitted: 3 over the argument bound, 3 to defect 5 above. Decided per source
  before any arm runs, so it cannot differ across arms.
- **Model.** `claude-haiku-4-5`, every one of 8,725 calls reporting
  `claude-haiku-4-5-20251001`. Agent temperature 1.0, construction temperature
  0.0, 512 output tokens per turn, base receiving the summed budget in its
  single turn.
- **Trials.** 3, seeds 20260801/02/03, construction seed 20260803.

**Linkage.** The preregistration digest is hashed into `model_config_digest`,
which is hashed into `design_digest`, which every family and run row carries.
Evidence produced under a different preregistration cannot validate. Verified
`design_digest`
`91df9cb81212bd23bd75b3d7855e97b6c7b8a6e122b02c930d2b96b8c8a44bba`.

`analysis.py` deliberately does not import `parallax.report`: it re-implements
the linkage checks and computes its own intervals, so it takes no dependency on
the `threshold` / `powered` / `action` machinery being removed elsewhere, and
derives the arm set from the manifest rather than from a hardcoded arm tuple.
`runner.ManifestRecord` still requires a `threshold` field to construct; it is
set to the placeholder `0.0`, never read back, and means nothing here. This
study declares no threshold and returns no decision.

## Spend

$10.96 metered from provider-reported token usage, against a $10.32
preregistered estimate calibrated on the pilot.

| phase | calls | prompt tokens | completion tokens | USD |
|---|---|---|---|---|
| main construction | 877 | 112,907 | 73,132 | 0.479 |
| main episodes | 7,848 | 5,648,179 | 946,438 | 10.380 |
| calibration pilot | 95 | 49,968 | 10,015 | 0.100 |
| gateway probe | 9 | ~300 | ~200 | <0.001 |
| **total** | **8,829** | | | **$10.96** |

Priced at Haiku 4.5's $1/$5 per million input/output tokens via
`hud_screening.CLAUDE_HAIKU_PRICING`. Cost is summed over response-cache files,
one file per paid call, so resumed passes cannot double-count. No runaway spend:
actual came in 5% over a pilot-calibrated estimate.

## Operational notes

- Run under `caffeinate -dims` so macOS sleep could not kill it. Wall clock
  19m37s for the main run at 12 workers.
- **Zero gateway failures.** No retry fired and the consecutive-failure brake
  never engaged, across 8,725 calls.
- That brake raises a `BaseException` subclass on purpose. `run_script` converts
  every `Exception` into a recorded `RunFailure` and continues, so an
  `Exception`-based brake on a dead gateway would have quietly manufactured
  hundreds of fabricated run failures instead of stopping.
- Resumability is a per-call disk cache keyed on
  `(scope, source, trial, arm, call index, request digest)`. **The arm and trial
  are in the key explicitly.** Trials differ only by sampling nondeterminism, so
  their turn-0 messages are byte-identical and a key without the trial collides
  outright; the arm is keyed explicitly rather than relying on turn text
  differing, which is the SWE-bench cache-collision defect the brief warned
  about. Truncation (`BudgetError`) is cached because it is deterministic model
  behavior; transport failures never are.
- Concurrency without abandoning the audited path: a parallel `warm` phase fills
  the cache, then a sequential `evidence` phase replays through the package's
  own `run_experiment` on cache hits, so the committed evidence is written by
  package code rather than by this driver.

## Reproducing

```bash
cd parallax
uv sync --all-groups
python -m pytest -q                    # 138 offline tests, no network or key

# Live (costs money, needs HUD_API_KEY in the environment):
curl -sSL -o research/gsm8k-evolving-intent-live-20260803/work/gsm8k-test.jsonl \
  https://raw.githubusercontent.com/openai/grade-school-math/master/grade_school_math/data/test.jsonl
caffeinate -dims python research/gsm8k-evolving-intent-live-20260803/live_run.py \
  --label main --candidates 150 --trials 3 --workers 12 \
  --preregistration research/gsm8k-evolving-intent-live-20260803/preregistration.json

# Offline, from retained evidence:
gunzip -c research/gsm8k-evolving-intent-live-20260803/evidence/main-evidence.jsonl.gz \
  > /tmp/main-evidence.jsonl
python research/gsm8k-evolving-intent-live-20260803/analysis.py /tmp/main-evidence.jsonl
PYTHONPATH=research/gsm8k-evolving-intent-live-20260803 \
  python research/gsm8k-evolving-intent-live-20260803/verify_analysis.py /tmp/main-evidence.jsonl
```

## Files

- `preregistration.json`, `PREREGISTRATION-AMENDMENT.md` — frozen design and
  the reporting-emphasis amendment.
- `live_run.py` — ingestion, construction, warm, evidence phases.
- `analysis.py` — linkage validation and interval estimation.
- `verify_analysis.py` — byte stability, row-shuffle invariance, and rejection
  of dropped, duplicated, and seed-drifted rows.
- `probe_gateway.py`, `show_results.py`, `write_preregistration.py`.
- `evidence/main-evidence.jsonl.gz` — 1,296 graded episodes with full
  transcripts (7.8M raw, committed at 646K; `DIGESTS.txt` pins both digests).
- `evidence/main-analysis.json`, `evidence/main-construction.jsonl`,
  `evidence/main-spend.json`, `evidence/gateway-probe.json`, `evidence/pilot-*`.
- `NOTES.md` — chronological working notes, including each defect at the moment
  it was found.

Not committed: the fetched GSM8K split (digest-pinned in `DIGESTS.txt` instead)
and the 37M response cache.

## Verification

- `pytest`: 138 passed, including 14 new tests covering fence tolerance, raw
  provider bytes retained through unfencing, unterminated fences still
  rejected, per-stage schema statement, system-prompt delivery and retention,
  system prompt threaded to every arm, and temperature/seed reaching the wire.
- `pytest` under `PYTHONOPTIMIZE=1`: 138 passed.
- `ruff check` and `ruff format --check`: clean over `src`, `tests`, and this
  directory.
- `ty check src`: clean.
- `python -m build`: source distribution and wheel built.
- `verify_analysis.py`: all self-checks pass.

## Limits

- One model, one benchmark. Nothing here generalises to other models or to
  harder benchmarks without rerunning.
- Trials are temperature-1.0 samples, not seed-reproducible replicates, because
  the gateway ignores `seed`. Rerunning will not reproduce these numbers
  exactly; the retained evidence and its digests are the reproducible artifact.
- Construction quality is Haiku's. Intent extraction is uneven — one pilot
  source produced the function `calculate youngest son age` for a question about
  unwashed oranges — and every arm inherits whatever was extracted. Base scoring
  0.720 is the operational evidence that the rendered intent does determine the
  sealed answer, but no separate admission check enforces it.
- The population excludes the 14 comma-formatted rows and the 6 sources that
  failed admission, so it is 144 of 1,319 official rows selected under a
  declared seeded procedure, not a uniform sample of GSM8K.
- The primary contrast confounds intent evolution with multi-turn presentation
  by design. This run could separate them only because the matched arm ran;
  two-arm successors cannot.
