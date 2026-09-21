# Review slices

Five dependent draft PRs deliver this investigation. Each owns its authored code and evidence; the last includes the full existing-application patch. Review them in order. They preserve the repository's folder-only commit rule and exclude the implementation branch's earlier unrelated documentation commit.

| Draft PR | Delivery commit | Base |
| --- | --- | --- |
| [Typed runtime](https://github.com/nikhil-vytla/hatch/pull/58) | `4adf8c1fb80f` | `main` |
| [Routing and client integration](https://github.com/nikhil-vytla/hatch/pull/59) | `afb7cbf129d8` | `nikhil-20260920-jevTypedRuntime` |
| [Local study and Mac toolkit](https://github.com/nikhil-vytla/hatch/pull/60) | `d627e243769e` | `nikhil-20260920-jevRoutingToolkit` |
| [Playable scenes and design research](https://github.com/nikhil-vytla/hatch/pull/61) | `ce8b0243dae2` | `nikhil-20260920-jevLocalStudy` |
| Application and release evidence | Pending final branch check | `nikhil-20260920-jevPlayableLab` |

The application patch includes the standalone runtime corrections, so apply it directly to the original clean application. Do not first apply `runtime/existing-contracts.patch`. `apply.sh` checks conflicts and installs the provider-free workflow; it does not deploy or change Vercel settings.

## Branch verification

- Runtime: clean archived GitHub main plus the standalone patch passed 17 tests and 50 assertions. [Record](../runtime/standalone-check.json).
- Routing: the exact assembled branch passed 83 tests, 448 assertions, TypeScript and fresh installation, with no model calls. [Record](routing-branch-check.json).
- Study/Mac: fresh locked Python setup passed 11 Mac tests, nine study unit tests and the complete published-evidence/default-selection audit. The private-corpus integration test skips in the distributable checkout; it passed in the original measured environment. [Record](training-branch-check.json).
- Playable: the exact assembled branch passed 15 engine/helper tests and 47 assertions after locked Bun installation. [Record](playable-branch-check.json).
- Integration: the final branch will run the complete patch from archived source, build with canonical-root dependencies before sibling installs, compare all 45 prepared public files with the verified working build, and check all 61 evidence downloads by hash. Its report is added before publication.

These local checks are separate from GitHub status checks. Vercel previews on artifact-only PRs build the original application because the patch is not applied in their Git trees. They do not show the new homepage, footnote or routed endpoint. The public release remains open until the patch is applied to main and that exact GitHub-to-Vercel deployment is verified.

[Machine-readable PR mapping](pull-requests.json) retains both implementation and delivery commits. All implementation commits contain only `jev-experiments/roadmap`; the existing application changes remain in the working tree and in `application.patch`.
