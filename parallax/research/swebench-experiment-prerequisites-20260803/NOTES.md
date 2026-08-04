# SWE-bench experiment prerequisites notes

## Scope

This unit prepares the first static-versus-evolved experiment on
`astropy__astropy-14508`, `django__django-13786`, and
`pydata__xarray-4695`. It authorizes local Docker compute for admission
checks but no paid inference.

## Definition of done

- The harness owns scripted-turn delivery. An agent cannot request, skip, or
  drain turns.
- Early submissions and per-turn step exhaustion deliver the next turn.
- Grading before full delivery is a hard error.
- Every completed episode records steps consumed for each delivered turn.
- Static, matched, and evolved arms retain equal total budgets. Matched and
  evolved retain equal per-turn allocations.
- G1 through G6 produce one sealed-clean admission record per source.
- G3 uses an applied identity patch and G4 uses the retained source gold patch
  through the pinned official SWE-bench harness.
- The three boundary sources have committed admission evidence.
- Normal and optimized tests, mutation suites, lint, types, and build pass.

## Workflow

1. Capture the old pull-delivery behavior in a failing regression test.
2. Replace the director with a typed harness-side delivery state machine and
   migrate the HUD executor and environment in one wave.
3. Thread the gold patch through sealed authority.
4. Add typed admission records and G1 through G6 in pipeline order.
5. Run the cheap gates, then real G3 and G4 for the three boundary sources.
6. Extend mutation checks, update method documentation, and run the full gate.
7. Push a stacked PR and stop before experiment inference.

## Provenance

- Upstream turn delivery is characterized in PR #21 against
  `microsoft/evolving-intent` commit
  `993d6be9597ac03854b46362ccd647eb1bfd267a`. The relevant upstream locations
  are `evaluation/common/swe_minisweagent_scaffold.py:408-424` for the update
  wrapper, `:714-749` for submission interception, and `:750-787` for
  per-turn budget exhaustion.
- Admission predicates G1 through G6 come from PR #22,
  `parallax/research/admission-qc/README.md`.

## Decisions

- The core delivery shape is a typed receipt containing one phase record per
  scheduled turn. Completeness is constructed by the harness and revalidated
  by the environment at grading.
- The old `advance()` capability is deleted. There is no compatibility layer
  because every caller is internal and the pull API weakens the intervention.
- The environment receives the delivery receipt through the normal HUD answer
  channel. It exports a candidate patch only after validating complete,
  contiguous delivery.
- Admission evidence stores sealed fragment digests and lengths, never fragment
  bytes.

## Work log

- 2026-08-03: Confirmed PR #24 is open and clean. Created
  `cursor/parallax-experiment-prerequisites` stacked on its head.
- 2026-08-03: Read PR #21 and PR #22 source material. Confirmed the two design
  traps: the agent-visible director is skippable, and an empty model patch
  short-circuits the official harness before tests execute.
- 2026-08-03: Deleted the director and its MCP capability. Added
  `CompleteDeliveryReceiptV1`, `PhaseActivityV1`, and
  `TurnDeliveryController`. `HarnessTurnAgent` now intercepts an early
  submission, injects the next turn, and advances on per-turn step exhaustion.
- 2026-08-03: The environment now accepts only a typed complete-delivery
  answer. It checks the turn count and exact phase budgets before exporting the
  patch. `ScreeningRun` requires a complete receipt for every verified evolved
  run.
- 2026-08-03: Retained `_DatasetRow.patch` as sealed `gold_patch`. Added G1
  through G6, sealed-clean gate evidence, `AdmittedSweFamily`, and admitted-only
  scheduling.
- 2026-08-03: Ran G3 and G4 under `linux/amd64` for all three boundary sources.
  Every identity patch applied, ran tests, and produced WRONG with zero
  FAIL_TO_PASS successes. Every gold patch applied and produced PASS on the
  first attempt. All three decisions are `admitted`; none is
  `admitted_flaky`.
- 2026-08-03: The focused mutation gate killed six of six delivery and
  admission mutants. The existing core suite killed 28 of 28. The updated
  Slice 2 suite killed 48 of 48 after removing the obsolete `advance()` metadata
  mutant.
- 2026-08-03: Preregistered 18 Opus 4.8 units for approval only. The design has
  three sources, static and evolved conditions, and three paired trials. The
  prior nine static trials cost $0.908775. A conservative 2x evolved multiplier
  gives a $2.726325 estimate and a proposed $3.50 cap. No inference ran in this
  unit.
