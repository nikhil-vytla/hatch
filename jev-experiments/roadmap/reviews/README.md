# Independent review gates

Reviews use OpenCode with `amazon-bedrock/global.anthropic.claude-fable-5-1` through AWS Bedrock. Each gate saves the prompt, source-file hashes, feedback, OpenCode session identity and reported cost. Cost is not billing-verified. Review output is evidence to investigate, not an automatic specification.

| Gate | Feedback | Disposition |
| --- | --- | --- |
| Frozen protocols | [Protocol feedback](protocol-feedback.md), [provenance](protocol-provenance.json) | [Training findings](../training/REVIEW-DISPOSITION.md), [routing findings](../routing/review-disposition.md) |
| Integrated prototypes | [Prototype feedback](prototype-feedback.md), [provenance](prototype-provenance.json) | Table below and routing dispositions |
| Release candidate | [Release feedback](release-feedback.md), [provenance](release-provenance.json) | Seven findings tracked below; local artifact readiness is separate from public deployment |

The first two immediate session exports lacked readable assistant metadata. Repeating the export, without another model call, recovered the recorded provider/model identities. The provenance files retain that recovery. The runner now retries export separately from inference. The third gate exposed the cause of unreadable exports: piping a large OpenCode export truncated JSON at 65,534 bytes. Direct file output retained 971,766 bytes and verified 24 assistant messages from the requested Bedrock model without another inference call. The runner now uses file output.

## Prototype findings

| Finding | Resolution and evidence |
| --- | --- |
| 1. Live-route evidence predates strict artifact validation; recorder omitted later host-repair annotations | Preserve the initial malformed response, historical host repair and later strict failure as separate conditions. Freeze [narrow hunk normalization](../routing/HUNK-NORMALIZATION.md), then record one new real call. [Current evidence](../verification/live-route.json) includes the original malformed proposal, explicit toolkit correction, strict host application and passing independent tests. The host performed no repair. |
| 2. Review snapshot omitted required transcripts | The snapshot filter excluded JSONL/text/diff files. Expanded it. [Integration evidence](../integration/evidence/index.json) links the retained transcripts, MCP audits, host diffs and test output. This was a review-bundle gap, not proof that configuration parsing was the only test. |
| 3. Discovery alone was labeled as a meaningful result | Each summary now derives `delegationOccurred` from a successful tool result with an artifact and states an explicit condition gate. Historical failure variants remain failed even when the host independently fixed the source. |
| 4. Missing integration index and host metadata in the snapshot | [Integration README](../integration/README.md) and per-run summaries now include versions, model identity limits, chronology and historical failure variants. No unavailable host-model identity is invented. |
| 5. Snapshot omitted root credits, decisions, package and apply script | The runner now snapshots the whole authored roadmap tree, excluding local state, dependencies, caches and large binaries. The final review includes these files and attributed visual references. |
| 6. Web/CLI HTTP execution duplicated validation | Extracted `routing/http-executor.ts`. Shared tests enforce usage bounds, redirect rejection, malformed bodies and cancellation. |
| 7. OpenCode malformed result had inconsistent cost | Both success and malformed branches retain unknown cost. |
| 8. Audit write failure could reject outside MCP handling | Audit failures are caught; an actual stdio regression verifies the server remains usable. |
| 9. Recorded patch called correct without direct context; destination sources unclear | UI calls it a proposed patch and separates the recorded Bedrock/OpenCode destination from live Gateway routes. Actual host tests are linked in the integration evidence. |
| 10. Failure variants no longer reproduced by the current runner | Marked historical; current reruns refuse evidence overwrite. The historical command and output remain visible. |
| 11. Stale work checklist | Updated completed implementation items separately from outstanding export, final review and deployment gates. |
| 12. OpenCode fixture permission boundary | Current runner scopes reads/edits to its generated fixture and denies external directories. Host commands are bounded to fixture tests and diffs. |

## Additional independent checks

The implementation owners rotated into reviews of [routing boundaries](../playable/review/README.md), [Mac installation/runtime](../playable/review/mac-toolkit/README.md), [foundations](../playable/review/foundations/README.md), [training evidence](../playable/review/training/README.md), [default promotion](../playable/review/default-promotion/README.md) and [current scenes](../playable/review/release-scenes/README.md). Before/after probes remain beside each report. Consequential findings were reproduced without model calls where possible. Completed export evidence and the final Fable gate are retained separately from public deployment.

The scenes review found that the materials claim about frozen labels lacked public downloads. Both links now work, and [downloaded bytes match the frozen sources](../verification/materials-downloads.json). Root's subsequent claim review found stale Tetris copy saying no new live runs existed. The game now separates the historical benchmark from the six continuous-game runs, exposes their metrics and provides [verified protocol/trace downloads](../verification/tetris-downloads.json).

The protocol review suggested that upstream training on Typed Decisions train would itself make its test transfer evaluation leaked. We retain the review wording and disagree with that inference: exact test exposure is not established. Published backbone overlap remains unknown and is disclosed; the new adaptation excludes all Typed Decisions examples.

## Final source and publication preparation

An independent [Smol export check](../playable/review/smol-export/README.md) recomputed both complete 2,960-row streams and verified source, prediction, package and timing-input hashes without model calls. The final artifact audit retained only twenty selected images below 2 MB, with source URLs for every captured reference.

The root then reproduced a canonical-root deployment failure that the broader clean checkout had hidden: outside-root TSX components relied on sibling React types. Explicit application-local type resolution fixed the identical isolated checkout, with no sibling dependency installs and unchanged Vercel commands/root. [Original failure](../verification/vercel-root-first.json) and [correction](../verification/vercel-root-correction.json) remain separate. CI and clean verification now build the app before installing toolkit or adapter dependencies.

The last source simplification removes the unreachable old handler-router branch, keeps the micro agent's existing tool workflow, and gives every current catalog ID an explicit view. New optional setup sections expose the Mac guide/examples and coding-client configurations. Study manifests, provenance and review corrections are downloadable alongside complete comparisons.

## Release findings

The reviewer judged the local artifacts ready with corrections and explicitly withheld public-deployment readiness. Its inspection was read-only, did not recompute hashes or run code, opened two current screenshots and did not read every transcript or training source. Root and workstream checks below supply independent evidence rather than treating that judgment as an approval.

| Finding | Disposition |
| --- | --- |
| 1. “Production” could imply the public site | Accepted. Root README now says local preview of the production build. Canonical production and the unapplied patch remain separate. |
| 2. Clean report omitted timestamp and direct working-build comparison | Accepted. The verifier now records UTC time and both hashes for every one of the 45 generated public files. The delivery audit independently reproduced the 96,121-byte patch and its SHA-256 from current edits. The final run passed all eight commands and all 45 output comparisons after the routing corrections. |
| 3. Historical live-recorder source hash predates annotation renames | Retained as disclosed historical provenance. No current-code execution is inferred from it. |
| 4. “Five independent cases” overstated one test with five assertions | Accepted and corrected in the root README. All five inclusive-sum assertions did pass. |
| 5. Aggregate quality floor differs from calibrated ranking and escalation | Independently confirmed. Keep the classifier-independent aggregate hard floor required by the frozen policy. Require escalation to improve both aggregate and task-calibrated quality; 66 routing tests and 398 assertions passed, including the hard floor and escalation regressions; see [routing dispositions](../routing/review-disposition.md). |
| 6. A deleted comment can resemble a diff header | Independently confirmed. Corrected with valid comment-deletion and malformed-patch regressions. Root also reproduced a second-file missing-header case with `diff --git` metadata; a small per-file state guard now rejects it. The frozen count-only normalization protocol remains unchanged. |
| 7. Frozen-protocol typography | Retain historical bytes and hashes. These spacing defects do not change the protocol or measured results. |

The [delivery audit](../playable/review/delivery/README.md) checked selected artifacts, source imports, static downloads and exact patch replay. It found no omissions, oversized binaries, copied dependencies or credential-pattern matches under its documented scope.
