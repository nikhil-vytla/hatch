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
   kind, and `run_screening` preserves verifier failures.
4. **Confirmed and fixed — crash-unsafe evidence.**
   The merged runner held all outcomes in memory and wrote once. It now creates
   a partial file exclusively, fsyncs the manifest before the first executor
   call, appends and fsyncs each unit, validates resume identity, skips
   completed units, atomically finalizes, and refuses to overwrite final
   evidence.
5. **Confirmed and fixed — provider response incompatibility.**
   Request models still forbid unknown fields. Response-side models validate
   consumed values but ignore provider extensions, and a real-shaped response
   fixture covers top-level, choice, message, and usage extras.
6. **Confirmed and fixed — missing usage, model, and observed metering.**
   Each screening receipt carries the provider-reported model, prompt tokens,
   completion tokens, and estimated cost. The expected response model is
   preregistered and mismatches become run failures. Observed cumulative cost
   is checked after every persisted unit.
7. **Confirmed and fixed — unpinned and unsafe row query.**
   Dataset row requests carry the pinned `revision`; IDs are rejected against
   `PUBLISHED_INSTANCE_IDS` before query construction; truncated cells fail
   closed.
8. **Confirmed and fixed — output truncation classification.**
   Text chat raises `BudgetError` when `finish_reason == "length"` rather than
   grading a partial response as an invalid model answer.
9. **Confirmed; one cheap identity fix and remaining blockers.**
   Report validation now recomputes family script digests against the manifest.
   Screening identity still omits script, environment, and public provider
   configuration, so paid execution remains blocked on identity binding as
   well as official grading.

## No-spend implementation

- `HudGatewayProvider` uses the existing strict OpenAI-compatible request and
  response models, the HUD inference endpoint, `max_tokens`, and an eager
  `HUD_API_KEY` presence check.
- Screening execution receipts now retain prompt tokens, completion tokens,
  reported model, and estimated cost. The spend cap defaults to $5.
- The unsafe embedded-verifier renderer now fails closed unless explicitly
  enabled for offline inspection. This is a guard, not evaluator isolation.
- The scripted dry run exercised credential discovery and HUD request/response
  serialization without a network call. Its canonical receipt records
  `paid_calls: 0`.

## Verification

- 102 tests passed normally and under `python -O`.
- Ruff check and format check passed.
- `uvx ty check src` passed.
- Source distribution and wheel build passed.
- Core mutation suite: 28/28 killed.
- Adapted Slice 2/audit mutation suite: 30/30 killed.

## Rework before screening

Estimated effort is 2–4 focused engineering days plus Linux x86_64 Docker
validation. The safe path needs an agent image containing only public task and
turn data, evaluator-owned sealed instance data, candidate patch export that
includes untracked files, invocation of the pinned official SWE-bench harness,
named-status parsing, evaluator timeout classification, and identity digests
covering scripts, environment artifacts, image, HUD version, and provider
settings. No provider authentication probe, model episode, deployment, or paid
request should occur before that boundary is certified.
