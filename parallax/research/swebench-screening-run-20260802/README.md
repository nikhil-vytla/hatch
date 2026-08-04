# SWE-bench screening safety audit

The five-instance, two-trial static screening completed under the $5 cap.
Docker Desktop ran the official amd64 SWE-bench images under emulation, HUD
served Claude Haiku 4.5 construction and Claude Opus 4.8 episodes, and stored
candidate patches were graded evaluator-side by the pinned official harness.
The small design found two ceiling instances and three floor instances, but it
is underpowered and makes no advance/reject decision.

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
   strictly validate consumed fields and ignore provider extensions. The
   response boundary normalizes HUD's explicit null `tool_calls` to an empty
   tuple.
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
- Docker status: Docker Desktop was installed but stopped. Starting it restored
  the Linux/aarch64 daemon; `DOCKER_DEFAULT_PLATFORM=linux/amd64` passed an
  `x86_64` execution probe.
- Runtime isolation: the outer container requires Docker privilege so its
  inner UID-1000 `bubblewrap` namespace can create user namespaces. The probe
  confirmed that `/app` is absent and the agent sees only the public workspace.
- Outcomes: Astropy 0/2, Django 10914 2/2, Django 13089 2/2, Matplotlib 0/2,
  Requests 0/2.
- Operating points: floor, ceiling, ceiling, floor, floor respectively.
- Statistical result: underpowered, interval [0, 1], MDE 0.607361, no
  advance/reject decision.
- Known metered spend: $1.669650. Three failed construction responses have
  unavailable usage and a $0.477790 conservative reserve, so the all-in upper
  bound is $2.147440.
- HUD/API surprises: explicit null `tool_calls`, fenced construction JSON,
  scalar argument values, mandatory MCP tool descriptions, Docker Desktop
  user-namespace policy, and official empty-patch summaries without reports.
- Official harness packaging surprise: a wheel install omitted a required
  Cargo lock fixture. Evaluator-only regrading from the same pinned source
  revision produced the final verdicts without repeating paid inference.

## Verification

- 120 tests passed under normal and optimized Python.
- Ruff and format checks passed on project source, tests, and research scripts.
- `uvx ty check src` passed.
- Mutation suites: the scores originally reported here came from gauntlets
  that were never committed. The reproducible gauntlet is
  `tests/test_mutation_gauntlet.py` (`pytest -m mutation`).
- Canonical construction, episode, screening, summary, and failure evidence
  contain no credential value.
