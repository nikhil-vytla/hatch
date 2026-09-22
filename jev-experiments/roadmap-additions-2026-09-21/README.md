# Code quality and the next experiments

Code organization and style are now explicit first-release work. Three separate next-wave experiments investigate fast UI composition, inspectable table decisions and adaptive notebook interfaces. A GEPA domain-adaptation follow-up extends the existing prompt-optimization experiment. This folder contains source studies, named decisions and a separate delivery checklist. It does not implement these additions or add them to the public catalog.

| Workstream | Stage and owner | Decision and evidence |
| --- | --- | --- |
| Code organization and style | First release; root with runtime/scene owners | [Decision](decisions/code-organization-and-style.md): source/research/artifact boundaries, naming and code conventions, formatting/lint/types in CI, removal of obsolete code, clean-build and publication checks. |
| Fast UI composition | Next wave; root/design engineering | [Decision](decisions/fast-ui-composition.md), [Jeverative browser study](jeverative-analysis.md), [existing composer analysis](existing-composer-analysis.md). Prepared shadcn components, user-written style Markdown, app-pattern rules, bounded Jev decisions, optional later Qwen/Haiku refinement. |
| JevFrame review table | Next wave; training/runtime | [Decision](decisions/jevframe-experiment.md), [pinned source analysis and proposed study](jevframe-analysis.md). An uncertainty-filtered review queue with row inspection, complete distributions and CSV/JSONL export. |
| Adaptive notebook interface | Next wave; playable/design engineering | [Decision](decisions/adaptive-interfaces.md), [marimo-pets source analysis](adaptive-ui-analysis.md). Explicit context, bounded adaptation proposals, stable drafts/focus, freeze/undo and matched static/heuristic/Jev comparisons. |
| GEPA domain adaptation | Next wave; training/runtime, within existing prompt optimization | [Decision](decisions/gepa-domain-adaptation.md), [article and source analysis](gepa-analysis.md). Instruction/criterion search, fixed task semantics, probability error and downstream review outcomes; separate from local weight adaptation. |

[IMPLEMENTATION.md](IMPLEMENTATION.md) separates completed research from open delivery tasks. The code reorganization and sitewide UI/UX work remain release gates. These new experiments do not silently expand that release, and their protocols still need to be frozen before evaluation.

## Findings that shape the work

[Jeverative Interfaces](https://jeverative-ui.vercel.app/), credited on the site to [@hckmstrrahul](https://x.com/hckmstrrahul), made the basic interaction concrete. One authored inbox prompt was unsupported; the built-in inbox prompt produced a preview. The site displayed 1.35 seconds and the browser recorded a 1,712 ms API resource duration. Those timings have different boundaries; neither establishes end-to-end first-usable latency. Switching its preview width reset the local inbox selection and lost an unsent draft in the checked example. This makes task-state preservation an explicit acceptance condition for both composition and adaptation.

The existing local composer already has typed recipes, batching, state bindings, cancellation and recorded examples. Its three finished initial examples range from 1,651 to 21,607 ms, so a general 1–2 second claim would be premature. The new target is first usable composition, with final refinement measured separately. A valid style document must visibly affect supported tokens and rendered rules; a good-looking result that ignores it fails.

[JevFrame](https://github.com/ktaletsk/jevframe) and [marimo-pets](https://github.com/ktaletsk/marimo-pets) are Konstantin Taletskiy's MIT-licensed projects. The first is a Python hosted-SDK integration, while the second supplies contextual notebook companions. Neither study establishes an existing local Jev adapter or an adaptive Jev layout system. Their analyses retain pinned revisions, upstream credits, integration limits and proposed evaluation boundaries.

[shadcn/ui](https://github.com/shadcn-ui/ui) is the component source for the composition proposal. [Mobbin MCP](https://mobbin.com/mcp) is an optional authenticated design-research input; no connector was available in this session and no app-pattern collection was retrieved. Public source and reuse licensing for Jeverative's own implementation remain unverified. Implement independently unless that changes.

Praneeth Paikray's [GEPA case study](https://praneeth16.github.io/blog/adapting-jev-with-gepa/) belongs in the existing prompt-optimization workstream. Jev's instructions and criterion descriptions change while its model weights stay fixed. Our existing GEPA run found no held-out improvement; retain it alongside the new investigation. The proposed follow-up checks the downstream review policy as well as classification and probability metrics, preserving the completed local-model study and installed-default selection.

## Inspect the references

The browser study includes four attributed captures: [About](output/playwright/jeverative-about.webp), [unsupported request](output/playwright/jeverative-unsupported.webp), [desktop result](output/playwright/jeverative-preset.webp), and [mobile preview](output/playwright/jeverative-mobile-preview.webp). [capture-manifest.json](capture-manifest.json) records their dimensions, source, state, size and SHA-256. These are research references, not assets to reuse as Jev branding.

The broader visual direction remains in [DESIGN.md](../DESIGN.md) and the [design research](../design-revamp-2026-09-21/README.md). Its editorial page is a throwaway layout/interaction study using the materials engine; it makes no Jev calls and does not qualify as a shipped model experiment or finished article.

## Roadmap patch and verification

Per the repository's research convention, existing-file changes are supplied as [roadmap-update.patch](roadmap-update.patch). It updates the map, architecture note, implementation checklist and release gate. It depends on the earlier design roadmap patch; do not apply that prerequisite twice if it is already present.

From a checkout containing both research folders, first inspect whether the design roadmap changes are already applied. If they are absent:

```sh
git apply --check jev-experiments/design-revamp-2026-09-21/roadmap-update.patch
git apply jev-experiments/design-revamp-2026-09-21/roadmap-update.patch
```

Then apply this addition:

```sh
git apply --check jev-experiments/roadmap-additions-2026-09-21/roadmap-update.patch
git apply jev-experiments/roadmap-additions-2026-09-21/roadmap-update.patch
```

[patch-manifest.json](patch-manifest.json) pins the clean source revision, prerequisite hash and all before/after hashes. Applying the two patches in order to clean source files reproduced the working roadmap files exactly. [verification.json](verification.json) records the selected-artifact checks. Local Markdown links and decision/checklist anchors were checked, the four captures were visually inspected and are each below 2 MB, and an independent decision review led to the style-adherence acceptance case. No application or dependency code changed in this delivery, so application builds and model studies were not rerun.

Repeat the link, hash, size and patch checks with the standard-library-only verifier:

```sh
python3 jev-experiments/roadmap-additions-2026-09-21/verify.py
```

The independent GEPA arithmetic check fetches two pinned public prediction files, with no model calls or saved upstream data:

```sh
python3 jev-experiments/roadmap-additions-2026-09-21/gepa-check.py
```

Its retained [metrics and input hashes](gepa-verification.json) reproduce the comparison in the source study.

The Vercel root remains `jev-experiments/experience-prototypes`. This documentation addition makes no deployment or completed-experiment claim. [NOTES.md](NOTES.md) records the work and limitations.
