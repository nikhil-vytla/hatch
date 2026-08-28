# SWE-bench experiment prerequisites

The first static-versus-evolved experiment now has two enforceable
prerequisites. The HUD loop delivers every scripted turn, and the admission
pipeline checks each source before scheduling. No inference ran in this unit.

## Harness-side turn delivery

`HarnessTurnAgent` owns the turn schedule. The policy receives only shell tools.
It cannot call `advance()`, inspect future turns, or submit before the schedule
ends.

An early submission becomes the next user turn. A phase that consumes its step
budget also advances. Each transition uses `INTENT_UPDATE_PREFIX`, which matches
the authority wrapper characterized at
`evaluation/common/swe_minisweagent_scaffold.py:408-424` in
`microsoft/evolving-intent` commit
`993d6be9597ac03854b46362ccd647eb1bfd267a`. Submission interception follows
the upstream loop at lines 714-749. Budget exhaustion follows lines 750-787.

The environment grades only `CompleteDeliveryReceiptV1`. The receipt contains
one `PhaseActivityV1` per turn, with its step budget, consumed steps, and
advance trigger. A missing turn, a skipped index, or a changed budget is a hard
error before patch export.

## Admission pipeline

The pipeline runs these gates in execution order:

1. G6 records arm completeness or a uniform construction rejection.
2. G1 round-trips `SweScriptFamily`, `TaskSpecV1`, and `EnvSpecV1`.
3. G5 checks equal episode budgets and equal matched-versus-evolved phase
   allocations.
4. G2 scans compiled agent artifacts. Failure evidence stores only the artifact
   path, fragment digest, and byte length.
5. G3 applies a new inert file as an identity patch. The official harness must
   run the tests and return non-PASS with zero FAIL_TO_PASS successes.
6. G4 applies the sealed source gold patch. The official harness must return
   PASS. Only infrastructure failures are retried, with three attempts at most.

`AdmittedSweFamily` binds a family to its spec, environment, and compiled bundle
digests. `build_admitted_screening_plan` accepts only that type, so a rejected
or changed family cannot reach new scheduling code.

## Real G3 and G4 results

All checks ran locally with `DOCKER_DEFAULT_PLATFORM=linux/amd64`, the pinned
SWE-bench harness revision, and digest-pinned official images.

- `astropy__astropy-14508` is admitted. The identity patch applied and returned
  WRONG with 0 FAIL_TO_PASS successes. The gold patch passed on attempt 1.
- `django__django-13786` is admitted. The identity patch applied and returned
  WRONG with 0 FAIL_TO_PASS successes. The gold patch passed on attempt 1.
- `pydata__xarray-4695` is admitted. The identity patch applied and returned
  WRONG with 0 FAIL_TO_PASS successes. The gold patch passed on attempt 1.

No source is `admitted_flaky`.

## Preregistered experiment for approval

The stopped design contains 18 units. It uses the three admitted sources,
Claude Opus 4.8, static and evolved conditions, and three paired trials per
source. Both conditions receive 12 total agent steps and 4096 output tokens.
Static receives one 12-step phase. Evolved receives two 6-step phases.

The same nine static units cost $0.908775 in Round 2. The cost estimate assigns
the evolved units a conservative 2x multiplier for the second model turn and
its repeated context. The resulting estimate is $2.726325. The proposed
approval cap is $3.50.

The design is recorded at
`evidence/single-vs-evolved-design.json`, with design digest
`e230043ce85483b90e636b594e828dd78f525ddd9fd4bc6a25bf11caeeda4eaa`.
No experiment unit has run.

## Evidence and verification

- `evidence/admission-summary.json` records the three decisions and the pinned
  parquet digest.
- `evidence/<instance>/admission.json` records every gate, official report
  digest, image digest, and outcome without sealed text.
- `decision-trail.tsv` links each implementation unit to its check.
- `mutation_gate.py` kills six focused delivery and admission mutants. Its
  successor is committed as `tests/test_mutation_gauntlet.py`, which runs under
  `pytest -m mutation`.

Verification passed 136 tests under normal Python and 136 under `python -O`.
Ruff, Ruff format, `ty`, `uv build`, and `git diff --check` passed. The
"core" and "Slice 2" mutation scores this report originally cited came from
gauntlets that were never committed and cannot be reproduced; the reproducible
gauntlet is `tests/test_mutation_gauntlet.py`.

Reproduce the compute-only admission run with:

```bash
DOCKER_DEFAULT_PLATFORM=linux/amd64 uv run --with pyarrow python \
  research/swebench-experiment-prerequisites-20260803/run_admission.py
```
