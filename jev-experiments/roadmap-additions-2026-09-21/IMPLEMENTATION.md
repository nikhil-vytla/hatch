# Delivery checklist

Named decisions explain scope and unresolved questions. This file tracks work. Research completed here does not mark an experiment implemented.

## Code organization and style, first release

- [x] Inspect existing architecture notes, package commands and the current composer boundary.
- [ ] Inventory maintained source, research, generated artifacts, imports, commands and owners.
- [ ] Resolve the directory map and source/evidence ownership in the [decision](decisions/code-organization-and-style.md).
- [ ] Establish naming, formatting, lint, type and test conventions with examples and CI commands.
- [ ] Move code in reviewable slices; separate formatting-only changes from behavior.
- [ ] Remove unused dependencies, duplicate helpers and obsolete paths; record deliberate customization.
- [ ] Run relevant checks, canonical-root clean build and publication-integrity checks after migration.
- [ ] Verify the exact GitHub revision through the existing Vercel project before public release.

## Fast UI composition, next wave

- [x] Inspect Jeverative's public UI and attribution; record successful and unsupported examples.
- [x] Review the existing local composer and its actual recorded evidence.
- [ ] Resolve catalog, style-document rules, initial app patterns and data/history semantics in the [decision](decisions/fast-ui-composition.md).
- [ ] Build an attributed app-pattern reference set, using authenticated Mobbin access if available.
- [ ] Freeze the workflow suite, baselines and timing/cost definitions; review the protocol.
- [ ] Implement the style compiler, shadcn subset, Jev choices and deterministic responsive renderer.
- [ ] Verify distinct supported style documents change compiled tokens and rendered rules as specified; check required pattern regions/actions and explicit unsupported rules.
- [ ] Add optional Qwen/Haiku refinement as a separate validated, reviewable proposal.
- [ ] Run matched tasks and publish failures, coverage, first-usable latency and final-result latency.
- [ ] Complete interaction/accessibility review, export, an evidence-backed note and entry experience.

## JevFrame review table, next wave

- [x] Inspect pinned upstream source, license, output semantics and runtime limits.
- [ ] Resolve runner/package provenance and execution modes in the [decision](decisions/jevframe-experiment.md).
- [ ] Freeze the proposed corpus, split, transformations, questions, metrics and request budget.
- [ ] Implement a pinned Python runner and explicit mapping to shared decision artifacts.
- [ ] Add provider-free row, failure, cache and cancellation checks.
- [ ] Run the bounded evaluation and publish coverage, calibration, performance and accounting.
- [ ] Build the recorded threshold/filter interaction, row inspector, CSV/JSONL export and note.
- [ ] Review keyboard, mobile, dark mode and reduced motion before catalog inclusion.

## Adaptive notebook interface, next wave

- [x] Inspect marimo-pets, its attribution, context controls and compatibility boundaries.
- [ ] Resolve the supported state transitions, context, adaptations and control policy in the [decision](decisions/adaptive-interfaces.md).
- [ ] Freeze tasks, static/heuristic/Jev conditions and stability/usability metrics.
- [ ] Implement an explicit context inspector and finite adaptation proposals.
- [ ] Add freeze, undo, dwell rules, revision checks and state-preserving application.
- [ ] Record complete task runs, failures, intervention counts, churn, latency and cost.
- [ ] Verify drafts/focus/selection, keyboard, supported mobile use, dark mode and reduced motion.
- [ ] Publish an attributed replay/export and working default before catalog inclusion.

## GEPA domain adaptation, existing experiment, next wave

- [x] Locate the existing GEPA runner, published negative result and optimization audit.
- [x] Complete the attributed article/source study, inspect code/data licenses and recompute the published paired test metrics.
- [ ] Choose the domain, objective and integration details in the [decision](decisions/gepa-domain-adaptation.md).
- [ ] Recheck and repair remaining incomplete-evaluation, protocol/resumption and score-display issues.
- [ ] Freeze data groups/splits, prompt components, calibration policy, controls, seeds and total search budget; obtain the frozen-protocol review.
- [ ] Compare instruction-only and instruction-plus-criterion searches while keeping task semantics fixed.
- [ ] Publish paired held-out task metrics, calibration/coverage, review-policy outcomes and full cost/latency accounting.
- [ ] Extend the existing prompt-optimization view with recorded search replay, criterion diffs, ancestry, failure states and prompt export.
- [ ] Write an evidence-backed experiment note; keep local weight adaptation and installed-default selection separate.

After every two integrations and before release, review duplication and boundaries. Keep the first-release design and code-organization gates visible while these next-wave experiments are researched.
