# SWE-bench screening safety audit

The planned paid screening did not run. The merged scaffold exposes sealed
verifier data to the agent and does not implement official SWE-bench grading,
so its pass rate would not measure the preregistered outcome.

## Finding dispositions

1. **Confirmed, blocking — verifier disclosure.**
   `src/parallax/swebench_env.py:27` reads `/app/instance.json`;
   `:233-241` puts test IDs, command, and patch in that file; and `:254-262`
   copies it into the one container used by the environment. There is no
   agent/evaluator filesystem boundary.
2. **Confirmed, blocking — invalid grading semantics.**
   `src/parallax/swebench_env.py:64-109` checks only the test process return
   code. The named test sets are counts, `git diff --name-only` excludes
   untracked files, and checkout of every patched test path fails for files
   added by the sealed patch. The pinned official harness instead separates
   modified and new test paths, parses repository-specific named statuses, and
   requires all `FAIL_TO_PASS` and `PASS_TO_PASS` tests to pass.
3. **Confirmed and fixed — failure taxonomy.**
   Merged `src/parallax/screening.py:237-246` converted every executor exception
   to an agent failure. `ScreeningExecutionError` now carries the typed failure
   kind, and `run_screening` preserves verifier failures at `:289-312`.
4. **Confirmed and fixed — crash-unsafe evidence.**
   The merged runner held all outcomes in memory and wrote once. It now writes
   the manifest before the first executor call, atomically persists each
   completed unit, validates existing receipts, and resumes without repeating
   completed units (`src/parallax/screening.py:256-326`).
5. **Confirmed; two fixes and one remaining blocker.**
   Dataset row requests now carry `revision=` at
   `src/parallax/swebench.py:307-312`. The manifest now precedes outcomes.
   Screening identity still omits script, environment, and public provider
   configuration (`src/parallax/screening.py:158-217`), so paid execution
   remains blocked on identity binding as well as official grading.

## No-spend implementation

- `HudGatewayProvider` uses the existing strict OpenAI-compatible request and
  response models, the HUD inference endpoint, `max_tokens`, and an eager
  `HUD_API_KEY` presence check.
- Screening execution receipts now retain prompt tokens, completion tokens,
  and estimated cost. The spend cap is configurable; a future approved run
  must pass `spend_cap_usd=5.0`.
- The scripted dry run exercised credential discovery and HUD request/response
  serialization without a network call. Its canonical receipt records
  `paid_calls: 0`.

## Verification

- 92 tests passed normally and under `python -O`.
- Ruff check and format check passed.
- `uvx ty check src` passed.
- Source distribution and wheel build passed.
- Core mutation suite: 28/28 killed.
- Adapted Slice 2/audit mutation suite: 21/21 killed.

## Rework before screening

Estimated effort is 2–4 focused engineering days plus Linux x86_64 Docker
validation. The safe path needs an agent image containing only public task and
turn data, evaluator-owned sealed instance data, candidate patch export that
includes untracked files, invocation of the pinned official SWE-bench harness,
named-status parsing, evaluator timeout classification, and identity digests
covering scripts, environment artifacts, image, HUD version, and provider
settings. No provider authentication probe, model episode, deployment, or paid
request should occur before that boundary is certified.
