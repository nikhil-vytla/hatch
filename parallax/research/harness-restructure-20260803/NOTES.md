# Restructure work log

## Baseline (after merging PR #27 / checkpoint evolution into main)

`pytest -q` = 138 tests green. Package = 5,551 LOC across 21 modules;
tests = 3,538 LOC; dated research drivers = 2,919 LOC across 21 scripts.

Three parallel type trees for the same three concepts:

| concept | Evolving Intent (GSM8K) | SWE-bench | checkpoint evolution |
|---|---|---|---|
| arm name | `Arm = Literal["static","matched","evolved"]` | same, imported from the method | `CheckpointArm = Literal["evolved","carry-reference"]` |
| one turn | `Turn(text, events, state_after)` | `SweTurn(text, state_after)` | `CheckpointDelivery(index, public_spec, workspace, max_output_bytes)` |
| one arm's script | `Script(arm, problem, turns, max_output_tokens)` | `SweScript(arm, problem, turns, agent_steps, max_output_tokens)` | implicit in `run_checkpoint_family(arm=...)` |
| the set of arms | `ScriptFamily` | `SweScriptFamily` | `AdmittedFamily` + `CE_ARMS` |
| the loop | `runner.run_experiment` | `screening.run_screening` | `checkpoint_runner.run_ce_experiment` |
| the analysis | `report.build_report` | `research/.../analyze_experiment.py` | `research/.../summarize_screening.py` |
| the journal | write-all-at-end | append+fsync, resumable | write-all-at-end |

So: three loops, three analyses, two of which are outside the package, and only
one of the three journals is resumable.

## Verifying the audit claims before acting

- `conformance.py`: no importer outside `tests/test_conformance.py`. VERIFIED dead.
- `INITIAL_SCREENING_IDS`: only user is `test_swebench.py:32`, which asserts
  `len(...) == 10` on a tuple literal defined 60 lines above. VERIFIED.
- `build_swe_script_family(seed=...)`: stored as
  `SweScriptFamily.construction_seed`, read by `freeze_swe_specs` into
  `PublicTaskV1.construction_seed`, and never used to seed anything. The SWE
  construction is deterministic; there is no RNG. VERIFIED fake.
- `trial_seed`: `screening.ScreeningUnit.trial_seed` is digest-bound in the
  plan, and `HudExecutor.__call__` never passes it to `create_agent`. VERIFIED
  — preregistered per-trial reproducibility was fiction.
- Token pricing: `hud_screening.CLAUDE_{OPUS,HAIKU}_PRICING`,
  `checkpoint_agent.HAIKU_STAGE_PRICING`, `summarize_round2.RATES` (which
  additionally knows Sonnet, which the package does not), and
  `preregister_experiment.py` body literals. FOUR copies, VERIFIED.
- `report.py` vs `analyze_experiment.py`: the paired-bounds block is a
  line-for-line reimplementation with the contrast sign flipped
  (`evolved - matched` vs `static - evolved`). Same epsilon
  `sqrt(2*ln40/n)`, same clamp, same clustering. VERIFIED duplicate.
- `summarize_round2._classify` operating point uses `== 0` / `== 1`;
  `screening.summarize_screening` uses `<= 0.1` / `>= 0.9`. VERIFIED drift,
  but see below — the drift was behaviourally inert.
- `runner.run_experiment` / `report.report_from_jsonl` / `conformance.run_conformance`:
  no callers outside tests and `docs/PIPELINES.md`. VERIFIED.

## Where the audit was wrong

1. **`delivery.py`'s "duplicate base types" are load-bearing.** `hud_compile`
   ships `delivery.py` into the agent image as `parallax/delivery.py` next to an
   *empty* `parallax/__init__.py`. `from .types import StrictModel` would
   `ModuleNotFoundError` inside the container. The duplication is real but it
   is not gratuitous. Fixed properly by shipping `types.py` into the bundle too
   and importing it, rather than by deleting one of the two copies.

2. **The drifted operating-point thresholds did not mis-select anything.**
   Round 2 ran 2 or 3 trials per instance, so the observed pass rate is in
   {0, 1/3, 2/3, 1} (or {0, 1/2, 1}). Every value strictly between 0 and 1 is
   also strictly between 0.1 and 0.9, so `== 0`/`== 1` and `<= 0.1`/`>= 0.9`
   partition those samples identically. The flagship instances were selected
   correctly. The drift was a latent bug, not a realised one — worth deleting,
   not worth a correction notice on the result.

3. **`sealed_leakage` is not merely redundant with `compile_hud`, it is
   unreachable.** `compile_hud` calls `assert_agent_artifacts_clean` and
   raises, so `admit_swe_family` cannot reach its own leakage gate with a leak
   present: the gate can only ever record `passed=True`. Stronger claim than
   the audit made.

## Decisions

- `Arm` dies. Conditions are `Condition = NewType("Condition", NonEmptyText)`.
  A perturbation declares the conditions it produces; an experiment config
  declares which of them it runs. Nothing in a shared type knows a condition
  name.
- Budget is `required + headroom`, not a flat cap. See README; this is the
  checkpoint byte-cap trap made hard to express.
- `runner.py` and `report.py` are deleted rather than kept. Their design is
  three-arm GSM8K with `matched` as the control, and `matched` was retired by
  the user mid-task. Keeping them would have meant keeping a second experiment
  loop and a second analysis path for a design nobody will run again, which is
  the exact duplication this task exists to remove. GSM8K now runs through the
  one loop; see README for the port.

## Log

- Merged `origin/main` (PR #27, checkpoint evolution) before starting.

## Matched arm: reversal, and what it forced

The instruction to delete the matched arm was reversed after a 1,296-episode
live GSM8K run. Evolved came in 0.109 below single-turn base, 95% interval
[-0.160, -0.060]; against the matched control that splits into -0.086 from
multi-turn presentation and -0.023 from intent evolution on top, the latter
spanning zero. Two conditions would have credited the whole drop to the
manipulation and named the wrong mechanism.

What that changed in the design, and what it did not:

- Still deleted: the three-arm `Literal`, the validator requiring all three, and
  any family being forced to construct arms nobody runs. No type says three, and
  no type says two either.
- Added: `VariantSet.control`, an optional condition a perturbation offers. The
  experiment's `conditions` decides what gets paid for. Constructing a condition
  is free; running one is not.
- `intent_phases.py` now builds `matched` with GSM8K's semantics — one true
  argument revealed per turn, goal fixed. The retired SWE version delivered the
  whole issue statement in every turn and accumulated nothing, so it controlled
  for nothing while passing a gate that only compared turn counts and per-turn
  budgets. Two adapters, one name, different meanings, invisible. That is the
  single best argument for one perturbation module.

Tests: `test_intent_evolution.py` (new file; the module had none after
`evolving_intent.py` was deleted) asserts the per-turn reveal and that the three
conditions share total headroom. `test_swebench.py::test_the_control_accumulates
_information_instead_of_repeating_itself` pins the fixed SWE semantics.

## One place for the agent contract

Three defects from the live run were each invisible offline because scripted
agents satisfy contracts real models do not: the agent was never told about
`FINAL_ANSWER:`, construction prompts never stated their JSON schema, and the
GSM8K parser lacked the fence tolerance `swebench.py` already had.

Fixes, in the order they matter:

1. `AgentContract` lives in `task.py`; every adapter exposes `agent_contract`,
   and `VariantSet` requires one. `VariantSet.prompts(condition)` is the only
   accessor that yields agent-facing text, and it cannot be called without the
   contract because the contract is a required field of the set that owns the
   material. `Turn.text` stays the perturbation's material and is what the digest
   covers. A runner that renders `Turn.text` is visibly skipping the contract.
   The contract goes on every turn, not just the last: several runners call the
   provider once per turn with no conversation state, so a contract stated once
   would never reach turn two.
2. `provider.json_schema_instructions(model, purpose)` derives prompt text from
   the Pydantic model that will validate the reply. A prompt can no longer
   describe a shape its parser rejects. Both construction paths use it.
3. `provider.unfence` is the one fence stripper, used by the GSM8K parser, both
   construction parsers, and the checkpoint file-map parser.

The contract is inside the verifier digest, so relaxing what the grader accepts
changes the task's identity instead of silently regrading old evidence.

## Trials are samples

The gateway accepts `seed` and ignores it — same seed, different completions,
verified empirically. So `TrialSeed` is gone, `ExperimentConfig.trial_seeds`
became `trials: PositiveInt`, and `Unit` carries only a `trial_index`.
Temperature is causally real, so it is a preregistered field on both the plan
and the model-config digest.

While doing this I found the plan's digested body was a dict written out by hand
next to the `Plan(...)` call — adding a field to the design left it out of the
digest. Replaced with `_sealed()`, which digests the plan's own dump. Adding
`temperature` was the test case: the hand-written version would have silently
excluded it.

## Research drivers deleted

Removed 2,874 lines across 17 driver scripts in six dated `research/` folders,
keeping every evidence file untouched. They were variations on one
construct/plan/execute/resume/summarize skeleton; one imported another via
`runpy.run_path` and mutated its `__globals__`. `summarize_round2.py` had drifted
to classifying operating points at `== 0`/`== 1` against the package's
`<= 0.1`/`>= 0.9`, and that drifted copy selected the instances for the flagship
experiment.

`findings.from_journal(path)` plus `python -m parallax.findings JOURNAL` is the
one analysis path now. `research/checkpoint-evolution-slice/run_screening.py`
survives as the shape a driver should be: argument parsing, then a call into the
package, then `render(from_journal(...))`.

## Docs touched

Structural only; wording left to the parallel agent.

- `README.md`: replaced both module walkthroughs (they named six deleted
  modules) with the four-concept map.
- `docs/PIPELINES.md`: rewrote the GSM8K walkthrough against the new API and
  verified it runs as written; the real output is pasted in. Marked the deleted
  SWE drivers as historical, and replaced the "matched control was missing" note
  with the sharper finding that the control existed and was broken.
- `docs/RESEARCH-PROCESS.md`, `docs/MODEL.md`, `docs/methods/evolving-intent.md`:
  renamed entry points and types that moved.

## Verification

`pytest` 171 passed, `pytest -O` 171 passed, `ruff check`/`format` clean over
`src/`, `tests/`, `research/`, `docs/`. Pyright reports 108 pre-existing errors
against 111 on `origin/main`, all from `NewType` over `Annotated` in `types.py`;
no type checker is configured in `pyproject.toml`. The remaining repo-wide ruff
findings are in `.cursor/skills/` helper scripts, untouched and failing before
this branch.
