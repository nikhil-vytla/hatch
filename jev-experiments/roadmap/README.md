# Jev release lab

This folder contains the release implementation, measured integration work and design research for the existing [Jev experiments site](https://jev-experiments.vercel.app). The application stays at `jev-experiments/experience-prototypes`. Per the repository's research convention, changes to existing code are delivered as [application.patch](application.patch); all new toolkit, simulation, study and report files live here. The model study and default installation are complete. Browser checks passed against a local preview of the production build. Public deployment remains a separate gate.

## What works

- The [shared decision contract](runtime/contract.ts) carries typed questions, full distributions, execution identity, timing and explicit unsupported/error/cancellation results. Regression tests cover the two earlier gateway/decoder defects.
- The [routing toolkit](routing/) exposes TypeScript, CLI and local MCP operations. Hard eligibility, selection, execution and outcomes are separate. Recorded prompts, destination results and caller-owned-key execution are available in the integrated Model Routing Lab.
- [Real coding-client fixtures](integration/) invoked the MCP tool from OpenCode, Claude Code and Codex, applied proposed work through host tools and passed independent tests. Failed setup and malformed-response attempts remain visible.
- The [materials sandbox](materials/README.md) provides six materials, a typed custom slot, pointer/touch/keyboard painting, branches, saved scenes and JSON exports. It leads the play-first homepage. Scene controls run locally; Jev interpretation is optional and unmeasured.
- [Crowd and music changes](playable/README.md) add editable notices, per-person observations, matched notice comparisons, musical continuity filters, saved scores and source-hidden auditions. Automated browser checks submitted no listener preferences.
- [Six live Tetris games](tetris/README.md) preserve matched queues and separately report actual controller time. The original full game, handoff, synchronized branches and adjustable 700 ms grace remain intact.
- The [typed-decision study](training/README.md) completed three recipes across three seeds and retains all 17,760 Core ML/MLX decision comparisons. It includes state-blind, lexical, embedding and frozen-model baselines, option-order sensitivity and explicit derivative/coverage labels. Validation selected the experimental Laya readout; all 400 released Typed Decisions cases remain a separate transfer condition.
- The [experimental Mac toolkit](mac/README.md) installs inference dependencies separately, verifies model checksums, diagnoses setup, and classifies explicitly supplied `.eml` files offline. Its authored email smoke set scored 7/12, so it is not an endorsed mail-triage default.
- The [design-engineering study](design-research/README.md) includes cited builder research, captured visual references, a [reference board](design-research/reference-board.html) and an [original interactive style study](design-research/style-study.html). Public credits separate Laya's model creator from its playground author and credit the original scoring methods. The site footer includes the requested TypeSafe AI affiliation statement.

## Apply and verify

From a checkout at the recorded base commit, with this folder present:

```sh
sh jev-experiments/roadmap/apply.sh
cd jev-experiments/experience-prototypes
bun install --frozen-lockfile
cd ../adapters/typescript
bun install --frozen-lockfile
cd ../../roadmap
bun install --frozen-lockfile
bun verification/check.ts
```

The application patch is already applied in the implementation working tree. `apply.sh` first checks the patch and refuses conflicts, then installs the provider-free GitHub workflow. It does not deploy. The canonical Vercel root, Bun install/build commands and parent-source access stay unchanged.

[Clean-checkout verification](verification/clean-checkout.json) builds from archived Git sources plus this folder and patch, with no copied prepared public assets, caches or models. All 45 generated public files matched the working build byte for byte. The final verifier builds with only the canonical application-root dependencies before installing any sibling tools; the [earlier masked failure and correction](verification/vercel-root-correction.json) explain that ordering. [Publication integrity](verification/publication-index.json) hashes every committed input and output; the checker also proves original fields and array order survive JSONL preparation. [Check results](verification/checks.json) record exact commands and outputs.

[Live web routing evidence](verification/live-route.json) records an actual selected-destination call, an explicitly normalized single-hunk proposal, strict host application and one independent test with five assertions. The toolkit changed only the incorrect hunk counts under the frozen [normalization rule](routing/HUNK-NORMALIZATION.md); the exact original proposal remains in the result. The host performed no repair. The [initial malformed response](verification/live-route-first-malformed.json), [historical host repair](verification/live-route-historical-host-repair.json) and [strict-application failure](verification/live-route-strict-failure.json) remain separate conditions. This is evidence of a working path and its limitations, not an assurance that generated patches always apply.

The existing Go and Rust adapters also passed with [temporary official toolchains](verification/other-adapters/README.md), without changing source or global tool configuration. [Local production-build visual checks](verification/visual-release.json), [56 actual downloads](verification/downloads-release.json) and [eight active scene timing samples](verification/PERFORMANCE.md) supplement the functional reports. The build preserves all 61 downloadable assets byte for byte. Browser reports distinguish emulated mobile checks from physical-device testing. Routing comparisons use only four held-out authored tasks; the recorded policy replay does not establish a classifier advantage or real-world savings.

## Research and release gates

Read the [work map](MAP.md), [implementation checklist](IMPLEMENTATION.md) and [frozen training protocol](training/PROTOCOL.md) before continuing. The training study keeps the earlier workflow specialist separate, excludes Typed Decisions from adaptation, freezes corpus transformations and selection, and evaluates all 400 released transfer cases. Published backbone training overlap remains partly unknown. Readout adaptation on three datasets does not establish general-purpose capability.

All three Fable 5.1 Global gates retain [feedback, verified model provenance and finding dispositions](reviews/README.md). The completed model/export and default-package evidence is linked in the map. The [five review slices](delivery/README.md) deliver authored code and the application patch. Public deployment must still be checked explicitly before marking the first release complete. Successful preview checks on artifact-only PRs do not deploy the patch.

Code, protocols, evidence and screenshots are authored or captured for this investigation. Downloaded model weights, cached upstream datasets, full fetched repositories, build output and raw private tool state are excluded.
