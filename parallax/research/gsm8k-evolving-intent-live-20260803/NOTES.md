# Notes: GSM8K Evolving Intent, first real-provider run

Chronological working notes. Appended as work happened.

## 2026-08-03 — Framing

Standing TODO in `docs/RESEARCH-PROCESS.md` ("Deliberately out of scope" →
Real-model evidence): every Parallax GSM8K run to date used scripted agents.
This unit closes that gap.

Instruction received mid-task: **do not** size to the ε/power gate, and do not
design around `powered` / `action` / `threshold`. Another agent is deleting
that plumbing from `report.py` on a separate branch off `main`. So:

- Target sample is a judgment call, order 40-60 sources × 3 arms × 2-3 trials.
- Analysis computes per-arm accuracy and paired contrasts with plain
  confidence intervals, reported as facts.
- No advance/reject/underpowered language anywhere in the deliverable.
- My analysis code must not add new dependencies on
  `threshold`/`action`/`powered`. `runner.ManifestRecord` still *requires* a
  `threshold` field to construct, so I have to pass something to build the
  manifest, but I will not read it back or interpret it. Analysis is computed
  by a local module over the evidence rows, not by `report.build_report`.

Worktree: `/Users/nikhil/work/hatch-gsm8k-live` on `parallax-gsm8k-live` off
`origin/main` (`dc5bb5e`). The primary checkout is running someone else's paid
experiment; untouched.

## 2026-08-03 — Reading the offline path

`gsm8k.py` / `evolving_intent.py` / `runner.py` / `report.py` / `provider.py`.

Findings that matter before spending anything:

1. **Construction is already LLM-based.** `build_script_family` takes a `Chat`
   callable and calls a model three ways: `extract-intent` (1 attempt),
   `counterfactual` (2 attempts, once per extracted argument), `predecessor`
   (2 primary attempts + 1 optional fallback). So task item 1 is not "our code
   is hand-authored where upstream uses an LLM" — it is "this LLM construction
   has only ever been driven by scripted stubs". Running it for real is still
   the gap. Scheduling (`_schedule_events`) is seeded-deterministic and is a
   *declared* divergence from upstream (documented in
   `docs/methods/evolving-intent.md` → Interpretation and limits: upstream's
   predecessor generator uses an unseeded `random.Random()`).

2. **No submission contract is ever shown to the agent.** `run_script` builds
   the transcript from `Turn.text` only — no system message. But `gsm8k.grade`
   requires the final non-empty line to be `FINAL_ANSWER: <integer>`, with
   exactly one marker in the whole message. Scripted test agents
   (`conftest.HistoryAgent`) emit the marker because they are scripted. A real
   model has never been told. Predicted live consequence: near-100% `invalid`.
   This is exactly the class of defect this unit exists to find.

3. **Default per-turn budget is 64 output tokens.** `provider.text_completion`
   raises `BudgetError` on `finish_reason == "length"`, which `run_script`
   converts to `RunFailure(kind="budget")`. A real model doing grade-school
   arithmetic in 64 tokens will truncate constantly, and every truncation is a
   run failure that widens the bounds rather than scoring the model.

4. **Construction JSON parsing has no fence tolerance.** `_parse_model` calls
   `model_validate_json(output)` directly. `swebench.py:417` already learned
   this lesson and strips ```` ```json ```` fences; the GSM8K path never got
   the fix.

5. **Seeds are recorded but never reach sampling.** `run_experiment` passes
   `trial_seed` to the agent factory, but `provider.text_completion` builds a
   `ProviderRequest` with no `seed` and the default `temperature=0.0`. So
   preregistering per-trial seeds today would preregister a fiction. Need to
   either wire it or say so plainly.

## 2026-08-03 — API key

`zsh -lc` presence check: `HUD_API_KEY` present, length 42. Never printed.

## 2026-08-03 — Gateway probe (evidence/gateway-probe.json)

Nine calls, well under a cent, run before freezing anything. Every prediction
above was confirmed and one was worse than predicted.

- `claude-haiku-4-5` resolves and reports `claude-haiku-4-5-20251001`.
- **Temperature is causally real.** Three calls at `temperature=1.0` with an
  identical prompt returned `7382`, `7284`, `7382`. So trials at T>0 are
  genuine independent samples.
- **`seed` is accepted and silently ignored.** The gateway does not reject the
  OpenAI-style `seed` field (no 400), but two calls with `seed=12345` returned
  `7482` and `7392` — different outputs, same seed. Seeds therefore cannot be
  made causally real against this gateway. I will wire the field (it is the
  standard parameter and would be causal on a provider that honours it) and
  state plainly in the report that this provider ignores it, rather than
  preregistering reproducibility I do not have.
- **Construction returns fenced JSON, and the wrong schema.** The
  `extract-intent` stage prompt is `parallax-stage:extract-intent\nReturn one
  strict JSON object.` Haiku answered with a ```` ```json ```` fence wrapping
  `{"intent": ..., "problem_type": ..., "given_information": {...}, ...}` —
  nothing like the required `{"function", "arguments"}` shape. Two independent
  defects: the parser has no fence tolerance (`swebench.py:417` already strips
  fences; the GSM8K path never got the fix) and the prompt never states the
  schema. Offline stubs hid both because they returned the right shape by
  construction.
- **No submission contract reaches the agent.** Asked a rendered intent turn
  with no system prompt, Haiku replied in Markdown prose ending
  `**Total clips sold:** 48 + 24 = **72 clips**`. `gsm8k.grade` would call that
  `invalid`. Every live episode would have scored `invalid` and the entire run
  would have measured prompt formatting rather than intent evolution.

## 2026-08-03 — Design change mid-run: matched arm retired

Instruction arrived while the main run was in flight: drop the matched arm,
report base (static) versus evolved as the primary contrast, and state that the
three-arm design is being retired because the control is only worth its cost
when the sample can support the attribution it exists for. A restructure agent
is concurrently removing the hardcoded three-arm `Literal` from `specs.py`, so
I must not add code that depends on it.

State when the instruction landed: construction 145/150 receipts, 139 admitted
families, 863 paid construction calls, **zero episode calls**.

Which branch of the instruction applies turns on one fact I had to check:
**constructing the matched script costs nothing.** `_matched_turns()` is pure
local rendering off the already-extracted source intent — it issues no provider
calls. Construction spend is extraction + counterfactuals + predecessor, all
shared by all three arms. So "do not construct the matched script at all" saves
exactly $0. Matched's entire cost is its episodes: 139 x 3 trials x ~9 turns
≈ 3,750 calls, ~45% of remaining episode spend, ~$4.50.

So the real choice was: pay ~$4.50 for matched episodes, or execute two arms.
Two-arm execution is not a config flag here. It would require breaking
`ScriptFamily.controlled_arms` (requires exactly three arms),
`_build_manifest` / `ManifestRecord.unique_design_units` (validates the
arm-config set equals `{source} x ARMS`), and `run_experiment` (iterates
`family.scripts`). Patching those collides directly with the restructure agent
working on that same pin; hand-rolling a two-arm evidence writer would move my
evidence off the package's audited path.

Decision: **let the three-arm run finish.** Trading $4.50 for a merge conflict
with an in-flight refactor plus a bespoke evidence path is bad economics, and
the standing instruction is to spend what the science needs and treat only
runaway spend as a defect signal. $4.50 is not runaway. Reporting follows the
mid-run branch: static vs evolved primary, matched secondary with the
retirement note. Bonus: this preserves the retired arm's final dataset, so the
retirement rationale can be argued from evidence instead of assertion.

Nothing in my analysis code depends on the three-arm `Literal`; `analysis.py`
iterates whatever arms the evidence contains via `ARMS` for labelling and the
contrasts are named pairs, so a two-arm evidence file flows through it.

## 2026-08-04 — Two more live-only defects, found during the main run

**Resume path was broken.** The first resume attempt died reading back its own
cached families: `ScriptFamily.model_validate(dict)` fails because
`StrictModel` sets `strict=True`, under which a JSON list will not coerce into
a declared `tuple` field. Nine validation errors, every tuple field. The pilot
never caught it because the pilot completed in a single pass — only a crash
reaches the resume path. Fixed by validating through
`model_validate_json`, which does coerce arrays to tuples.

**Construction stage budgets are hardcoded and too tight.** 3 of 150 sources
(gsm8k-test-0690, -0883, -0988) failed construction with
`BudgetError: provider response reached its output-token limit`.
`build_script_family` passes literal budgets to its stages — 256 tokens for
`extract-intent`, 128 for `counterfactual`, 128 for `predecessor` — and the
`max_output_tokens` parameter only sizes *episode* turns, not construction. On
problems with many quantities, Haiku's extraction JSON exceeds 256 tokens and
truncates. Not fixed here: raising it would change construction for every
source mid-run, after the design was digest-bound. Recorded as a defect with a
recommended fix.

Admission tally, 6 of 150 rejected: 3 over the declared argument bound (7, 7,
8 extracted arguments), 3 to the construction budget above.

## 2026-08-03 — Fix list before spending

1. `evolving_intent._parse_model`: tolerate Markdown fences.
2. `evolving_intent._request`: state the exact JSON schema per stage. First
   line must stay `parallax-stage:{stage}` — `tests/conftest.py:36` dispatches
   on it.
3. `runner.run_script` / `run_experiment`: optional `system_prompt`, prepended
   to the transcript so it is sent and retained in evidence. Identical across
   arms, so it cannot confound the contrast.
4. `provider.text_completion`: accept and forward `temperature` and `seed`.
5. Raise the per-turn output budget off the 64-token default. The default is
   `max_output_tokens: int = 64`, and `provider.text_completion` raises
   `BudgetError` on `finish_reason == "length"`, which `run_script` turns into
   `RunFailure(kind="budget")`. A real model reasoning about grade-school
   arithmetic in 64 tokens truncates constantly, and every truncation would
   have widened the bounds instead of scoring the model. Set to 512 per turn.

## 2026-08-03 — Calibration pilot, 4 sources x 3 arms x 1 trial

$0.100, 95 calls, 0 failures. All three arms delivered every scheduled turn;
static 4/4 pass, matched 2/4, evolved 4/4. Purpose was operational calibration,
not inference, and its four sources are held out of the main population.

Measured unit costs used to size the main run: $0.0031 per source for
construction, $0.0219 per source-trial for all three arms. Mean 3.75 extracted
arguments, mean 8.5 evolved turns.

Checked the rendered scripts by hand. Static for gsm8k-test-0295 reads "I need
help with calculate oranges left unwashed. Use total oranges: 15. Use oldest son
age: 8. ..." and the model answered 3, matching sealed authority. So the
rendered intent does determine the sealed answer. Extraction is uneven though —
an intermediate state for the same source carried the function "calculate
youngest son age" for a question about oranges. Every arm inherits whatever was
extracted, so this is a construction-quality limit, not an arm confound.

Also noticed the matched arm's filler turns: for a 4-argument source with 9
turns, turns 4-8 are five repetitions of "Keep the same goal and values from the
conversation." That is the declared matched control, but it means matched's
extra turns are no-ops while evolved's carry corrections.

## 2026-08-03 — Sample size

Instruction was 40-60 sources x 3 arms x 2-3 trials, scaled up if cheap. At
pilot rates, 150 sources x 3 trials costs about $10.3 and takes well under an
hour, so went with 150 — roughly 2.5x the suggested upper end, still trivial
spend. 150 source clusters puts the paired-contrast standard error near 0.03,
which is an informative interval.

Found and fixed a selection bug before freezing: `random.sample(pop, k)` is not
prefix-stable across different `k`, so taking the first 4 of a 154-sample does
not reproduce a 4-sample. Disjoint pilot and main samples cannot be carved that
way. Replaced with one seeded full shuffle plus a slice, and the four pilot
source ids are excluded from the pool by name.

## 2026-08-04 — Main run

144/150 admitted, 1296 episodes, 8725 calls, 19m37s wall clock at 12 workers
under `caffeinate -dims`. Zero gateway failures — no retry fired, the
consecutive-failure brake never engaged. Every call reported
`claude-haiku-4-5-20251001`. $10.86, plus pilot $0.10.

Every scheduled turn delivered in every episode: 432/432 complete in all three
arms. Matched and evolved both delivered 3708 turns, identical as the
budget-matching invariant requires. Episode turns (7848) equal metered episode
calls (7848) exactly, so no turn was silently retried or dropped.

Results, source-clustered with 95% percentile bootstrap:

| arm | pass | accuracy | 95% CI |
|---|---|---|---|
| static | 311/432 | 0.720 | [0.648, 0.789] |
| matched | 274/432 | 0.634 | [0.563, 0.704] |
| evolved | 264/432 | 0.611 | [0.539, 0.683] |

| contrast | estimate | 95% CI | SE |
|---|---|---|---|
| evolved − static | −0.109 | [−0.160, −0.060] | 0.026 |
| matched − static | −0.086 | [−0.130, −0.044] | 0.022 |
| evolved − matched | −0.023 | [−0.081, +0.035] | 0.029 |

Zero run failures means identification bounds coincide with point estimates, so
no conclusion depends on missing-outcome handling.

The decomposition is the interesting part: about four fifths of the evolved
versus single-turn gap (−0.086 of −0.109) is multi-turn presentation alone, not
intent evolution. Worth stating that this is exactly the number the matched arm
exists to produce, and exactly what two-arm successors give up.

Four invalid submissions, all evolved, all the same mode: the model ended its
final reply asking a clarifying question with no `FINAL_ANSWER` line, after a
late correction left a value looking underspecified (e.g. "60% of [base
amount]"). Correctly counted against the model. 4/432 moves nothing, but only
the evolved trajectory induced format non-compliance.

Construction after the schema fix: 834 attempts across 144 families, **zero
rejected**. Before the fix the very first probe returned a completely wrong
schema. 834/144 = 5.79 calls per family = 1 extract + 3.79 counterfactuals + 1
predecessor, so every stage succeeded first try.

## 2026-08-04 — A defect in my own analysis

Ran the repo's byte-stability discipline against my own analysis and it failed:
shuffling evidence rows changed the reported interval. Cause is mine — the
source-clustered bootstrap resamples cluster means *by index*, and I built the
cluster list from a `defaultdict` in insertion order, which follows row order.
The point estimate is a mean and was fine; only the interval moved. Fixed by
sorting clusters by source id everywhere before the bootstrap.

Wrote `verify_analysis.py` to make this a standing check rather than a one-off:
byte stability, invariance under four row shuffles, and rejection of dropped,
duplicated, and seed-drifted rows. All pass.

## 2026-08-04 — Corrected a claim I had made too early

The amendment initially asserted that evolved − matched had an interval "wider
than either arm's own accuracy interval". That is false — arm accuracy intervals
are about 0.14 wide, the contrast is 0.116. Replaced with what the data
supports: among the three contrasts it has the largest SE (0.029), the widest
interval (0.116), the smallest estimate (−0.023), and is the only one spanning
zero. The retirement argument holds on those grounds; it did not need the wrong
one.

## 2026-08-04 — Verification and packaging

pytest 138 (124 pre-existing + 14 new), 138 again under `PYTHONOPTIMIZE=1`,
`ruff check` clean, `ruff format --check` clean after formatting the four files
I authored, `ty check src` clean, `python -m build` produced sdist and wheel.

Evidence is 7.8M raw, so committed gzipped at 646K with both digests pinned in
`evidence/DIGESTS.txt`. The fetched GSM8K split and the 37M response cache are
not committed; the dataset is digest-pinned instead.

Left deliberately unfixed, with rationale in the README: `load_gsm8k` rejecting
the official split (fixing it would change grading authority semantics inside a
PR about the live run) and the hardcoded construction stage budgets (raising
them mid-run would change construction after the design was digest-bound).
