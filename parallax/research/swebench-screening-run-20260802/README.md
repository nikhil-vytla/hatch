# SWE-bench screening safety audit

The blocking measurement defects are fixed, but the five-instance paid
screening did not start. HUD accepted the local API key for model discovery,
then returned HTTP 403 on the first construction inference request. No model
response or token-usage receipt was returned, so recorded spend is $0.

## Finding dispositions

1. **Official grading — fixed.** Candidate patches are evaluated by
   `swebench.harness.run_evaluation` at
   `f7bbbb2ccdf479001d6467c9e34af59e44a840f9`. The evaluator writes a local
   sealed dataset row, invokes the pinned harness against the digest-pinned
   official image, treats its `resolved` verdict as authoritative, and checks
   that the report covers the committed FAIL_TO_PASS and PASS_TO_PASS sets.
2. **Verifier sealing — fixed.** Generated agent images contain only public
   source and script data. The candidate patch leaves the HUD container before
   the evaluator supplies the sealed test patch and test IDs to the official
   harness. HUD 0.6.12 provides a native `Workspace` boundary backed by
   `bubblewrap`; the runtime additionally requires a UID drop and probes that
   `/app/instance.json` is absent from the agent namespace before yielding a
   task.
3. **Added and untracked files — fixed.** Patch export uses a temporary Git
   index seeded from `base_commit`, then `git add -A` and a binary cached diff.
   It includes modified, deleted, and untracked new files without altering the
   agent's index. The obsolete test-file restore implementation was deleted;
   the official harness applies the candidate patch in a fresh image.
4. **Provider wires — fixed.** Request models remain closed. Response models
   strictly validate consumed fields and ignore provider extensions.
5. **Evidence persistence — fixed.** The manifest is fsynced before execution;
   each completed unit is appended and fsynced; final evidence cannot overwrite
   an existing file. Paid HUD episode receipts are persisted before official
   grading so a grader crash does not repeat inference.
6. **Usage and model identity — fixed.** Receipts retain `response.model`,
   prompt tokens, completion tokens, conservative estimated cost, harness
   revision, image digest, and official report digest. The loop checks observed
   cumulative cost and reserves the configured upper cost before each unit.
7. **Dataset pinning — fixed.** The source boundary validates requested IDs
   against the paper's published set, binds both metadata and row requests to
   the dataset revision, and rejects truncated cells.
8. **Failure taxonomy — fixed.** Agent, budget, and verifier failures remain
   distinct. Provider output truncation is a budget failure; official harness
   exceptions are verifier failures and retain any already-paid HUD usage.
9. **Spec translation — fixed by construction.** `TaskSpecV1` separates
   `PublicTaskV1` from `SealedAuthorityV1`. `compile_hud` creates agent
   artifacts only from the public branch, tags each artifact by audience,
   scans the build context for sealed fragments, and records a digest receipt.
   The four-case conformance check matches reference and compiled grader
   outcomes.

## HUD isolation evidence

HUD's coding-agent documentation recommends keeping authoritative tests outside
the Workspace root. In SDK 0.6.12, `Workspace` runs agent commands in a
`bubblewrap` namespace whose defaults expose `/usr`, `/etc`, `/proc`, `/dev`, a
private `/tmp`, and the workspace root—not `/app`. The environment process owns
the public config and patch export; the official grader is a separate host-side
process and image, so sealed data is absent from the agent container rather
than relying only on permissions.

The remaining reproducibility limitation is agent-runtime packaging:
`hud==0.6.12` is exact and installed into an isolated virtual environment, but
its transitive wheels are resolved during the image build. This cannot alter
the separate official grader, but the resolved agent image should be committed
by digest before a comparative experiment.

## Screening attempt

- Scope: first five preregistered IDs, two static trials, Claude Opus 4.8,
  hard aggregate cap $5.
- Image manifests: five official amd64 images resolved to immutable Docker Hub
  digests before execution.
- Construction model: Claude Haiku 4.5.
- HUD model discovery: authenticated and listed both selected models.
- First inference: HTTP 403 from
  `https://inference.beta.hud.ai/v1/chat/completions`.
- Observed usage: 0 prompt tokens, 0 completion tokens.
- Estimated spend: $0.

The run stopped on the authorization denial as required. Retrying a different
model or endpoint would violate the stop condition; HUD inference entitlement
must be corrected before resuming the same manifest.

## Verification

- 112 offline tests passed.
- Ruff check and format check passed.
- `uvx ty check src` passed.
- Core mutation suite: 28/28 killed.
- Adapted Slice 2 mutation suite: 36/36 killed.
- The failure receipt is canonical JSON and contains no credential value.
