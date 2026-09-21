# Work notes

## 2026-09-20

- Started a fresh release implementation from the supplied plan. The work folder is `jev-experiments/roadmap`.
- The repository starts on `jev-live-worlds-quality`, with untracked `.playwright-cli/` and `output/` directories. Preserve these.
- The final research commit must contain only this folder, authored code, and diffs against existing code. Keep fetched code, model weights, and generated build output outside the commit.
- Preserve the canonical Vercel root `jev-experiments/experience-prototypes` and Bun commands.

- A command used app-relative working directory with root-relative file paths. Moved the one authored CI file into the intended folder and repeated the affected writes. Papercut CLI is not opted in for this repo; no log was created.

- User added design-engineering research and explicit builder attribution. Added the exact TypeSafe AI affiliation footnote, linked model and playground authors separately, and started a screenshot/style study of primary design-engineering sources.
- Broad verification passed: application171 tests, Python10 tests, original Apple metric3 tests, TypeScript adapters and new runtime/routing/materials/playable checks. Go is absent and rustup has no configured toolchain; provider-free CI includes them but these existing adapters were not locally run.
- Live Tetris completed all six unassisted games for three matched seeds. Both conditions topped out; outcome framing cleared0/3/1 lines and button framing0/0/0. Provider outages are retained, not rerolled.
- Real web routing exposed malformed JSON, then a correct-content patch with incorrect hunk counts after a schema change. Host git apply --recount repaired the header and five independent cases passed. Neither failure was silently discarded.

- Independent review reproduced ten runtime/publication/patch edge cases and four Mac installer/runtime/cache defects. Owners fixed them, and provider-free replay/regression evidence confirms the fixes.
- The Fable prototype review exposed omissions in the review snapshot (JSONL transcripts and root files), plus shared-executor duplication. Expanded the review snapshot and extracted one HTTP executor; preserved disagreements with review claims caused by its incomplete snapshot.
- User explicitly prioritized craft over backward compatibility. Refined material textures and direct painting/inspection controls; introduced an original serif homepage treatment without adding dependencies.
- Browser study verification found a brittle exact label query; gave the evaluation selector an explicit accessible name. Python's default TLS trust store failed the canonical URL check; repeated with system curl certificate verification, not disabled TLS.
- The existing GitHub-main production deployment and canonical URL are healthy. This research delivery still uses the application patch, so its changes are not claimed as deployed.
- Completed existing Go and Rust adapter tests with temporary official toolchains; source and global configuration remained unchanged.
- The independent default-promotion review found an install-order regression and incomplete package-source hashing. Both are fixed and CPU regression checks pass; promotion remains gated on complete export evidence.
- Prepared a reproducible active-scene browser profiler. It distinguishes requestAnimationFrame scheduling and callback work from physical display delivery; measurements will run after GPU work finishes.
- Expanded the final review snapshot to retain complete text comparison files even when they exceed the image-size budget.
- Repeated a notes append after using a repository-relative path from the work folder. The failed append changed no files; the accompanying TypeScript check passed.
- Replaced stale continuous-Tetris copy with the six-game matched-queue results and verified all three downloads against source bytes. Materials now has equally direct protocol/label downloads.
- Verified 21 routing evidence downloads in the production build. An initial rapid burst stopped after 10; 500 ms spacing passed. A protocol edited during the build needed a fresh build and one repeated download.
- Shortened the mobile home introduction and kept the first scene ahead of alternate-game links. The whole 322×215 px canvas now fits within 390×844 without scrolling; catalog search and category selection have explicit accessible names/states.
- Moved eight reviewed runtime/gateway regressions beside the contract. The isolated contract slice passes 17 tests; publication/patch regressions stay with their independent review.
- A report update again used a root-relative path from the app directory and failed before writing. Repeated with an absolute work-folder path; formatting itself succeeded.

## Production evidence and review preparation

Rebuilt the production app after the mobile-home and public-evidence changes. All eleven checks in `verification/check.ts` passed, including the new asset hash audit, which found all 28 currently available evidence assets byte-identical. Added a reproducible production screenshot pass and drafted the final application-integration PR body. Model exports remain serialized; active browser measurements will begin only after that work releases the device. Public routing transcripts contain expected worktree/client-installation paths and one historical unrelated filename listing, but the independent audit found no credential values or private file contents.

The final routing protocol download initially timed out because the verification script had not opened its collapsed evidence section. Opening the section resolved it; the real downloaded file now matches the final protocol hash, and all 21 prior source hashes remain current. This was an automation setup error, not a product defect. The runtime/router isolated slice also passed 78 tests, 414 assertions, type checking and fresh installation. Its only early Mac dependency is the model registry, which will be checked again after default promotion.

The updated clean-checkout pass completed all eight steps against the 89,259-byte application patch. It copied no prepared public assets or models, rebuilt from committed inputs and preserved all available downloadable evidence bytes. Browser checks are retained separately; the workflow job is named `web-and-contracts` to avoid implying that its build/unit commands run a browser.

Added optional website setup sections for the router CLI, three MCP configurations, destination registry, delegation skill and Mac examples. The study now links frozen source/corpus manifests, provenance, selection and review corrections directly. Larger metric files download as build assets instead of being embedded in JavaScript. The source-hash audit covers these links too. This closes evidence/setup access gaps found during final review; no model or scene behavior changed.

The final duplication pass found unreachable handler-routing code left behind when Model Routing Lab replaced that catalog entry. Removed it, narrowed the old component to its four live variants, and made every catalog dispatch explicit. All 41 entries have a view; the micro-agent execution body is byte-identical to its prior version. The app build and typecheck passed after cleanup.

## Canonical-root build correction

The broader clean checkout installed sibling toolkit dependencies before building the web app. A narrower reproduction using only Vercel's application-root install failed because the outside-root TSX modules could not resolve React types. Added application-local React type paths while retaining Vite's single React runtime, the same Vercel root, and the same install/build commands. The identical failing checkout then passed its build with no sibling dependencies installed. Both attempts are retained. Reordered clean verification and CI so the canonical app build runs before sibling installs. Also corrected the app README's stale 29-page count and distinguished the old layout study from the current 41-entry catalog.

All final model/export and fresh default package gates passed; the six public comparison files contain 17,760 rows. A final metadata check found historical fitting statuses still saying export pending inside the current publication. The publisher now derives training completion independently; exactly three publication values changed and all fitting/export/selection/package hashes stayed unchanged. The download-verification script also needed its study selector narrowed: a broad main-element scan reached an older publication outside the new asset index. Current study downloads are now scoped to the study component; historical public JSON retains its separate 45-file integrity check.

## Completed production-browser checks

All 56 current router/study links were clicked and their downloaded bytes matched the production asset audit and source. All 61 asset files pass byte-hash preservation, including materials and Tetris evidence. Six production captures pass footer/overflow checks. Eight active scene samples ran serially on the Apple M4 Max after model work finished: p95 browser frame intervals were 16.7–16.8 ms, with no intervals over 33 ms, no long tasks, no overflow and no API attempts. Tetris had the largest p95 callback work, 7.1 ms; no extra GPU infrastructure is justified by these samples. The performance report keeps viewport emulation, callback timing and physical display/audio limitations explicit.

- Final Fable review completed using the exact requested Bedrock model, session `ses_f3d451f16ffewivNx71yMq0tCk`, 24 assistant messages. Piped export was truncated to 65,534 bytes; file output recovered 971,766 bytes and verified identity without another model call. OpenCode reported $3.08172775, not billing-verified. Fixed the review runner to export directly to a file.
- Independently accepted final review wording and provenance corrections: local production-build previews are not deployed-site tests, the live fix has one test with five assertions, and clean verification now retains UTC time plus 45 explicit working/clean output hashes. Routing is reproducing the diff-header and quality-escalation findings before the final branch is published.
- Started folder-only delivery. Runtime commit `884074b` in the implementation tree and matching GitHub-main-based `4adf8c1` contain only 18 authored roadmap files. Draft PR #58 is open. Existing application edits remain unstaged and preserved in the patch.

- Final router corrections passed 66 tests/398 assertions. Root independently found a second-file missing-header variant with `diff --git`; the routing owner reproduced it and added a small per-file structural guard. Frozen protocol and historical evidence bytes stayed unchanged.
- All 11 root verification commands passed after the corrections, including 98 shared tests/495 assertions and 171 application/engine tests. The rebuilt app preserves all 61 evidence assets. Chromium redownloaded all 56 routing/study artifacts and their bytes matched current source.
- Final clean verification passed all eight commands, built before sibling installs, and retained explicit equal hashes for all 45 prepared public JSON files. The verifier now captures its archive base at startup so a concurrent later commit cannot change the reported base.
- Routing draft PR #59 adds the reusable toolkit and actual client evidence. Its assembled branch passed 83 runtime/router tests, 448 assertions, TypeScript and fresh installation without providers or GPUs.
