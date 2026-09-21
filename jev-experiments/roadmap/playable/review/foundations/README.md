# Independent foundations review

Ten reproduced defects were fixed by root and independently verified. The retained review run passed 19 tests with 61 assertions. Root subsequently replaced source-text parsing with a direct integrity-helper import, removing two formatting assertions, and moved eight contract/gateway cases into [runtime/edge-cases.test.ts](../../../runtime/edge-cases.test.ts). The two publication/patch regressions remain in [foundations.test.ts](foundations.test.ts). This review made no provider requests, loaded no models and ran no GPU work.

## Findings and disposition

| Finding | Corrected behavior | Evidence |
| --- | --- | --- |
| `decide(null)` threw while constructing its error envelope | Returns `unsupported` with an invalid-request issue | Runtime probe and regression |
| A different model revision was accepted | A configured revision mismatch returns an identity error with no decisions | Runtime probe and regression |
| Adjacent large ordinal values collapsed during formatting | Representable numbers retain distinct values; invalid scales are rejected | Runtime probe and regression |
| A provider response containing JSON `null` was retried six times | Fails once as an invalid answer envelope | Gateway fixture and regression |
| Direct gateway execution could return success after cancellation | Checks caller cancellation before returning | Gateway fixture and regression |
| The native 12,000-character instruction limit was absent from runtime limits | Declares the limit and returns `unsupported` before fetching | Native adapter fixture and regression |
| Publication checks accepted an empty source object replaced with `null` or a number | Requires the output to retain object shape | Isolated preservation-function fixture and regression |
| Missing CI source caused patch application followed by copy failure | Preflights the source before changing application files | Temporary Git fixture and regression |
| The direct decoder accepted numeric values for string enum options | Choice values must be actual strings | Direct decoder regression |
| The direct decoder accepted arrays as probability maps | Probability maps must be non-array objects | Direct decoder regression |

The before/after fixture evidence is preserved in [runtime results](probe-results.json), [runtime results after fixes](probe-results-after-fixes.json), [publication results](publication-probe-results.json), [publication results after fixes](publication-probe-results-after-fixes.json), [patch results](patch-probe-results.json) and [patch results after fixes](patch-probe-results-after-fixes.json). The two adjacent decoder defects were reproduced directly, fixed, then covered by the final regression suite.

```sh
bun test jev-experiments/roadmap/runtime jev-experiments/roadmap/playable/review/foundations/foundations.test.ts
```

## Publication and delivery checks

A read-only execution of the publication inventory, with its report redirected to a temporary directory, passed for all 45 public records. JSONL round trips preserved the originals and no unlisted public files appeared. [Captured result](publication-current-check.json).

The patch fixtures proved three distinct outcomes: a normal patch plus CI installation succeeds; a conflicting existing CI file prevents application; and a missing CI source now prevents application. They operate on small temporary Git repositories rather than the working tree. `package-patch.py` includes the only current untracked application file outside the research folder, `api/route.ts`; the other outside-folder changes are tracked and included by its Git diff. No full checkout, fetched source tree or copied datasets were added to this review.

The review inspected the clean-checkout script and existing record encoder/decoder. It did not rerun the full clean build, live gateway, deployment or harness integration because root owns those checks. Runtime fixture success establishes these contracts, not model quality or release completion.
