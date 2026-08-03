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
- HUD v6's native Workspace is a `bubblewrap`-isolated SSH capability. SDK
  0.6.12 mounts `/usr`, `/etc`, `/proc`, `/dev`, a private `/tmp`, and the
  workspace by default; it does not mount `/app`. Its coding-agent guide uses
  the same pattern for authoritative tests outside the agent workspace.
- Replaced the embedded verifier with an evaluator-side topology. The generated
  HUD image now contains public issue/script data only and exports a candidate
  patch. A separate evaluator invokes `swebench.harness.run_evaluation` at the
  pinned harness revision against the digest-pinned official image.
- The runtime requires `bubblewrap`, drops agent shells to UID 1000, and probes
  that `/app/instance.json` is not visible before an episode. This is
  defense-in-depth: sealed verifier data is absent from the image.
- Moved the generated environment implementation into importable
  `swebench_runtime.py`; generated `env.py` is a one-line import. Extracted
  `canonical.py` and `outcome.py` leaves so SWE code no longer imports GSM8K
  grading internals.
- Candidate patch export uses a temporary index plus `git add -A`, covering
  untracked additions. The official harness supersedes the flawed test restore
  and process-return-code grader.
- Small-n reporting now exposes its Hoeffding interval and
  minimum-detectable-effect and remains `inconclusive`/`underpowered` until the
  source-cluster count supports the declared maximum MDE.
- Added paid-stage receipts before official grading, official report/image/
  harness commitments, and preservation of paid usage on verifier failures.
- Resolved immutable image manifests for five screening instances. HUD model
  discovery authenticated and advertised Claude Haiku 4.5 and Claude Opus 4.8.
- The first construction request returned HTTP 403 before a model response.
  Stopped immediately under the authorization-failure rule. Recorded usage is
  zero tokens and estimated spend is $0; the key value was never logged.
- Offline certification reached 106 tests and the adapted audit mutation suite
  killed all 34 active mutants.
