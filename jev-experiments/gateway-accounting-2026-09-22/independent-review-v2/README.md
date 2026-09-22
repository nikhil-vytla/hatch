# Independent gateway accounting review

Request changes for three reproduced correctness gaps in [draft PR #72](https://github.com/nikhil-vytla/hatch/pull/72). This review is pinned to selected source `8743d7282176e2bdbcff68ddc497c8803b55b6c0` and report head `ed8862509fe2cdec98c4856656e845f153e61b44`; it does not grade later fixes. Product source was not modified.

## Findings

1. **P2 — Cancellation from either final observer can resolve success.** The success branch calls `finish()`, which invokes both observers, then returns without checking the caller signal again. A synchronous `AbortController.abort()` inside either final `onAttempt` or `onAccounting` callback therefore yields a successful answer despite the aborted signal. Both variants reproduce with one authored response and one fetch invocation. Recheck cancellation after final observers before publishing success, preserving the observed charge and usage. Relevant code: [gateway success path](https://github.com/nikhil-vytla/hatch/blob/8743d7282176e2bdbcff68ddc497c8803b55b6c0/jev-experiments/experience-prototypes/server/gateway.ts#L418).

2. **P2 — An exception before dispatch invents an outbound attempt.** The pending attempt is pushed before the first `onAccounting` callback, outside the transport `try`. If that observer throws, fetch is never invoked, but the error reports one pending outbound attempt and unknown cost. The scope is explicitly `outbound-http-attempts`, so this overcounts requests and turns a known zero-dispatch charge into an unknown total. Remove the undispatched attempt, or represent planned work separately, when the pending observer fails; keep real earlier attempts intact. Relevant code: [initial accounting publication](https://github.com/nikhil-vytla/hatch/blob/8743d7282176e2bdbcff68ddc497c8803b55b6c0/jev-experiments/experience-prototypes/server/gateway.ts#L344).

3. **P2 — Incoherent partial token usage passes validation.** `usageIssue({inputTokens: 10, totalTokens: 4})` returns null; the same holds for output tokens. The gateway returns these contradictory values without an issue, and `accountingIssue` also accepts them. Sum equality is checked only when all three fields exist. Reject a known component greater than a known total while leaving genuinely missing components unknown. Relevant code: [usage coherence check](https://github.com/nikhil-vytla/hatch/blob/8743d7282176e2bdbcff68ddc497c8803b55b6c0/jev-experiments/roadmap/runtime/accounting.ts#L59).

[missed-cases.test.ts](missed-cases.test.ts) contains the six pinned-source tests: four intended failures and two passing controls. [observations.json](observations.json) records the actual returns, dispatch counts and accounting. The controls verify normal success and cancellation while a response is outstanding. The published [run-review.py](run-review.py) can rerun the checks with explicit archive/output arguments; source identity checks precede test execution.

## Source and execution closure

All nine selected hashes match both Git source and the corrected archive. The archive digest and all corrected verification-log digests match; both verifier digests also match. The original failed archive and logs were independently found by hash: the app built, then the test command failed on the missing sibling Zod import with 29 passing tests. The source correction changes only the workflow's dependency installation; product bytes are identical. Report-head changes contain evidence and verifier files only. See [identity-check.json](identity-check.json) and [dependency-condition.json](dependency-condition.json).

The [gateway CI run](https://github.com/nikhil-vytla/hatch/actions/runs/35752990035) completed both frozen installs, production build and the focused test command at the report head. Its log reports 31 passing tests and 948 assertions. CI checked out merge commit `edd5f8db53ff7443fde0a1c83603e5ee43acdbb4`; all nine selected files at that executed merge match the reviewed source, and its parents are the recorded base and report head. See [ci-execution.json](ci-execution.json) and [ci-selected-source.json](ci-selected-source.json). Publication integrity is a separate successful archived check, not a step in this gateway workflow.

The archived suite independently reran with **31 pass / 0 fail / 948 assertions**. The review regressions produced **2 pass / 4 fail / 12 assertions**. These passing baseline checks do not resolve the findings above.

## Supported behavior and limits

The selected source preserves structured Choice descriptions, Noul boundaries and ordered Score levels; malformed/undeclared requests fail before transport. Semantic rejection retains independently observed identity, charge and valid usage. Unknown earlier attempts prevent a claimed total; explicit zero and partial observations remain distinct. Existing final-observer exception tests confirm no extra paid request. Score interval tests use independent vertex enumeration rather than repeating the greedy implementation and passed for two through ten levels plus generated rounding cases; no Score-bound defect was found.

This review used authored responses and the existing ephemeral loopback redirect fixture. It made no provider calls and establishes no provider precision, live billing, deployment or runtime-quality claim. The retained logs replace private machine paths with explicit placeholders. No product diff exists because no product file was edited.

## Rerunning without changing recorded evidence

```sh
python3 run-review.py --archive path/to/verified-archive --output path/to/new-results --preflight-only
python3 run-review.py --archive path/to/verified-archive --output path/to/new-results
```

The archive directory must contain the pinned `source.tar` and its dependency-prepared `source/`, as produced by the owner verifier. The rerunner checks the archive digest and selected extracted-source hashes; it performs no installation. An existing output file, directory or symlink is refused. Preflight creates no output; a real rerun writes logs, observations where applicable and provenance only into the new destination.

Historical recorded results were produced by driver SHA-256 `e52a29621868db29a8eb9793e9c8ab036bd64568ddac4ddbbc272ff7299681e0`. The published rerunner is `cfad2566a70452e02b919ba57a263d5b48003342f531f7f01b37e93b43ca49b7` and has been checked only for argument/preflight behavior; it did not produce those retained results. [driver-provenance.json](driver-provenance.json) binds both versions to their appropriate records.
The v2 regression condition intentionally has four failing tests, so reproducing that condition returns a nonzero status. Its observation script is copied unchanged into the new output directory before execution, preserving the original observations file.
