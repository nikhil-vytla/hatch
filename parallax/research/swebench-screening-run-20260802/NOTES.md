# Screening audit notes

- Started from `origin/main` at `6e8067e`.
- No paid inference or HUD network request was made.
- `HUD_API_KEY` is present in the login-shell environment; its value was never
  printed or persisted.
- Confirmed that the generated HUD image copies sealed verifier material into
  the agent-visible `/app/instance.json`.
- Confirmed that the embedded grader treats process exit zero as success rather
  than parsing named `FAIL_TO_PASS` and `PASS_TO_PASS` statuses. It also ignores
  untracked candidate files and mishandles tests added by the sealed patch.
- Confirmed that screening mapped every executor exception to an agent failure,
  wrote its manifest after execution, and persisted no per-unit receipts.
- Confirmed that the datasets-server row request omitted the pinned revision.
- Confirmed that screening identity omits scripts, environment artifacts, and
  provider settings.
- Added a strict HUD gateway adapter, typed execution failures, pre-outcome
  manifest persistence, crash-safe per-unit evidence, resumability, usage/cost
  fields, a configurable spend cap, and revision-bound row fetching.
- Secure evaluator isolation and official SWE-bench named-status grading require
  architectural rework. Screening remains blocked until those are implemented.
- Consolidated review confirmed that strict response-side wire models would
  reject real OpenAI-compatible extensions. Response models now ignore unknown
  fields while retaining strict validation for consumed values and requests.
- Screening now uses an exclusive `.partial` file, append plus fsync per record,
  exact manifest-identity resume, and final rename without overwrite. Receipts
  include provider-reported model, usage, and estimated cost.
- Published IDs are validated before query construction, truncated dataset cells
  fail closed, and provider `finish_reason="length"` is a budget failure.
- Family script digests are recomputed during report validation.
- The unsafe embedded-verifier renderer now requires an explicit offline-only
  opt-in. This prevents accidental use but does not resolve verifier isolation.
