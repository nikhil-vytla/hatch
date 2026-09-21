I'll start with the orientation documents, reading them in parallel.

Now the router boundary. Let me inspect the routing toolkit and live-route evidence.

## Readiness judgment

**Local artifact readiness: ready, with wording corrections.** The router, integration evidence, study, default installation and credits hold up under source inspection. Every consequential finding from the prototype gate has a code- or evidence-level resolution I could confirm. Remaining issues are labeling precision and traceability gaps, not behavioral defects.

**Public deployment: not ready, and not claimed.** No evidence identifies a deployment of `application.patch`. `IMPLEMENTATION.md:20` is unchecked, `NOTES.md:21` and `delivery/integration-pr.md:32` state the patch is undeployed, and `canonical-deployment.py` only probes the existing site. This is correctly separated, but see Finding 1 on wording that blurs it.

## Findings (ordered by consequence)

1. **"Production" checks are local preview builds, not the public site.** `README.md:3` ("Production browser checks passed") and `README.md:38` ("Production visual checks") point to `verification/visual-release.json`, whose script (`verification/capture-release.py:49`, `download-release.py:54`, `profile-browser.py:20`) targets `http://127.0.0.1:5195`. The JSON says "Production preview in Chromium." A reader will read "production" as the Vercel deployment, which the same README says is a separate gate. *Source-proven.* Remedy: change both README phrases to "production-build preview checks (local)".

2. **Clean-checkout evidence cannot be traced to the current patch or to the byte-for-byte claim.** `verification/clean-checkout.json:3` records `patchSha256 58663d91…` with no `recordedAt`, and that hash appears nowhere else in the snapshot. `README.md:34` claims "All 45 generated public files matched the working build byte for byte," but the retained checks (lines 62–71) show only `publicationCount:45, roundTripPassed, unlistedPublicFiles:0` — a round-trip inside the checkout, not a comparison against the working build. *Uncertainty: I cannot hash `application.patch` with the available tools.* Remedy: add `recordedAt` and the comparison output to `clean-checkout.json`, or link the file that holds the working-build comparison.

3. **`live-route.json` source hash is stale by design.** `reportAnnotation` (line 148) discloses that `hostRepairApplied`/`toolkitNormalizationApplied` were renamed after the run, so `sources["live-route.ts"]` (line 5) does not describe the current `live-route.ts`. Disclosed, low. Remedy: none required; optionally record the post-rename hash beside the original.

4. **"Five passing independent cases" overstates the test shape.** `verification/live-route.ts:42` writes one `test()` with five `expect` calls over n∈{0,1,2,10,42}; `README.md:36` calls these "five passing independent cases." *Source-proven, minor.* Remedy: "one independent test with five assertions".

5. **Quality gates use uncalibrated route quality while ranking uses calibrated quality.** `policy.ts:316-321` (`minimumQuality`) and `router.ts:436-442` (escalation "stronger" filter) read `route.quality`, but ranking uses task-calibrated `quality` (`policy.ts:276-288`). No permission/budget widening results, and the current registry's flat calibration (`comparison/README.md:22`) makes it inert today. *Source-proven, low.* Remedy: use the calibrated value in both places or document the choice.

6. **`validatePatchHunks` misreads deleted lines beginning with `-- `.** `artifacts.ts:171-180` ends a hunk on any body line starting with `--- `, so deleting an SQL/Lua comment line produces a spurious count mismatch → `malformed`. `normalizeSingleHunkCounts` also declines (`artifacts.ts:52` requires exactly one `--- ` line). Failure is conservative (never accepts a bad patch). *Source-proven, low.* Remedy: treat `--- ` as a header only when followed by a `+++ ` line.

7. **Frozen-protocol typography.** `HUNK-NORMALIZATION.md:1,3` ("version1", "Frozen2026-09-21") and `comparison/README.md:24` ("were0 and0.2145", "returned403"). These files are hash-frozen; do not edit the protocol. Note only.

## Prior consequential findings — status

All 12 prototype-gate findings have verifiable resolutions:
- (1) Live route re-recorded under strict validation: I confirmed `artifacts.ts` would accept the `a/`/`b/` headers and recount `-1,5 +1,6` → `-1,5 +1,5`; original text retained in `artifact.repair.originalText`; host used `git apply --check` with no `--recount` (`live-route.ts:55-69`).
- (2)(3)(4) Transcripts, MCP audits, `host.diff`, `tests-before/after.txt` exist for `opencode`, `claude`, `codex`; `index.json` marks `codex-approval-default`, `claude-fable-unavailable`, `opencode-cwd-timeout`, `boundary-opencode` as failed/historical. Codex host model remains `configured: null` but is honestly labeled.
- (5) `credits.tsx:12-28` separates Nandakishor M / Convai Innovations (model), Wojciech Dobry (playground), Eric Zhang's openjev-sglang (scoring, explicitly not a CUDA port). Footer text exact in `main.tsx:996` and `application.patch:990`.
- (6)(7)(8) `execute.ts:40` delegates to `executeHttp`; both OpenCode branches return `costUsd: null` (`execute.ts:200,208`); `mcp.ts:75-82` catches audit write failures and `mcp.ts:217` catches `handle`.

## Claims independently verified

- Router never widens eligibility on fallback; unknown charges retain the full reservation (`router.ts:321`); malformed results are terminal, not fallback (`router.ts:460-467`); verification is skipped under a hard cap (`router.ts:354-357`).
- Default selection uses validation macro NLL only; forbidden inputs listed (`default-selection.json:41-47`); Laya 0.8843 < Qwen 1.0972 < Smol 1.5150 traces from `training/README.md:52` to `default-selection.json:11-27`.
- Fresh package hashes cover runtime, installer, requirements, credits, MLX helper, checkpoint and example (`default-package-verification.json:114-122`); network blocked, model argument omitted. Installed runtime is MLX (`jev-local-mlx`), and Core ML is evidence only — consistent with "device placement is not inferred from ALL."
- Laya BoolQ exposure and unknown backbone exposure disclosed (`training/PROVENANCE.md:7,11`).
- Materials reads only `?preset=` from the URL (`MaterialsSandbox.tsx:150`); no code writes private text to URLs. Reduced motion starts paused (`MaterialsSandbox.tsx:177-179`), matching the `PAUSED` label in `home-desktop-final.png` with `reducedMotion:true`.
- Music preference copy states "personal listening record, not a musical-quality benchmark" (`music-arranger.tsx:190,213`).
- Tetris page shows the 700 ms fallback wait and separate Local demo / Fallback / Gravity controller-time attribution (`frames-tetris-desktop.json:737` source text).
- Routing comparison explicitly disclaims classifier advantage and savings (`comparison/README.md:3,22,24`).

## Review limits

- No shell: I could not compute SHA-256 hashes, so no source/patch/evidence hash was independently recomputed (Findings 2–3 are therefore uncertainties, not reproductions).
- I inspected two screenshots (`home-desktop-final.png`, `materials-dark-final.png`) and the Tetris DOM text; I did not open the remaining 13 screenshots or the `playable/materials-craft/output/playwright` set.
- I did not read transcript contents (`stdout.jsonl`, `mcp-audit.jsonl`), only their presence and the index summaries derived from them.
- I did not read `training/PROTOCOL.md`, `REVIEW-DISPOSITION.md`, `metric-correction.json`, `robustness-*.json`, `publication-index.json`, `music.ts`, `crowd.ts`, the Tetris engine, or `TypedDecisionStudy.tsx` copy in full; tie-aware metric and ordinal-mapping checks rest on the README and `checks.json` test names.
- No network access; the canonical URL and Vercel configuration were not probed.
