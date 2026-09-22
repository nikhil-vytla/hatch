# Adapt decision instructions to the task

- Owner: training/runtime, with root/design engineering
- Stage: next wave; extend the existing prompt-optimization experiment
- Status: integration direction accepted; task, objective and protocol open
- Depends on: existing GEPA adapter, immutable search records, typed-decision contract, task-specific labels
- Evidence: [source analysis](../gepa-analysis.md), [existing optimization audit](../../quality-and-simulation-review/experiments/optimize.md), [current runner](../../src/jev_lab/optimize.py)

## Question

Can GEPA improve Jev's domain-specific instructions and option descriptions while preserving the intended decision and improving its downstream use?

## Direction

Fold the requested investigation of Praneeth Paikray's [Adapting Jev to Your Domain with GEPA](https://praneeth16.github.io/blog/adapting-jev-with-gepa/) into the existing prompt-optimization experiment. Add a named follow-up protocol and an inspectable comparison within that experience. Do not create a duplicate catalog page.

Credit Paikray for the Jev case study and [Lakshya A. Agrawal and collaborators](https://arxiv.org/abs/2507.19457v2) for GEPA, with the [original implementation](https://github.com/gepa-ai/gepa). Pin any adapted code and retain its license. The post investigates instruction/criterion search with a fixed decision model. It does not demonstrate weight training or a local inference runtime.

The existing repository already runs real GEPA alongside unchanged prompts, random mutations, hill climbing and OPRO-inspired proposals. Its bounded published comparison retained the original GEPA prompt and found no held-out gain. Preserve that negative evidence and its scope. Re-read current code against the earlier audit before repairing remaining incomplete-evaluation, resumption or display defects; do not treat every historical finding as an unfixed bug.

The extension should expose the original and revised instructions, option-description changes, candidate ancestry, the cases used for feedback, selection reasons and held-out outcomes. Add the recorded replay proposed in the existing audit, with no inference needed for playback. Editing a criterion starts a separate exploratory branch, with its own protocol and input revisions. Keep the actual task definition and option identities fixed; an optimizer must not redefine success to improve its own score.

Compare instruction-only search with instruction-plus-criterion search under the same declared budget. Use task metrics and a downstream review policy alongside probability error. Paikray's reported case illustrates why a higher F1 or lower Brier score need not satisfy a recall requirement. Choose the objective before searching and show the resulting tradeoff explicitly.

## Boundaries and open decisions

- Choose a bounded domain with usable labels and redistribution rights. The article's medical-literature task is source evidence, not authorization to ship a clinical decision tool. Existing intent data or the planned review-table task may provide a more practical first integration.
- Freeze grouped data splits, prompt components, objective, search budget, baselines and seed plan. Separate search feedback, candidate selection, policy calibration and final evaluation. Previously opened test examples cannot become a fresh confirmatory holdout.
- Treat incomplete provider evaluations as incomplete search evidence. Preserve successful rows and use a fixed recovery policy rather than ranking an outage as bad prompt quality. Record operational failures separately.
- Pin both evaluator and reflection models, library versions and prompt hashes. Account for reflection, evaluator calls, retries, orchestration, prompt growth, total latency and cost. Record missing usage instead of inventing totals.
- Use shared typed artifacts where useful. A local-model condition must be explicit and respect its limits; reject unsupported context rather than trimming the prompt silently. There is no automatic cloud fallback.
- Leave the completed local typed-decision protocol, model weights, export evidence and validation-selected installed default unchanged. Prompt adaptation is a separate condition and needs its own validation before any later default change.

## Completion gate

Freeze and review the new protocol before paid evaluation. Run unchanged and repeated-unchanged controls, declared alternative searches and GEPA on matched tasks; report every planned seed and retain failed or negative searches. Compute paired held-out quality changes, probability error, coverage and actual review-policy outcomes, with uncertainty and full accounting. Show whether the result preserves the task's semantics and user-supplied constraints. Do not infer calibration from the SDK confidence field.

The recorded experience must make the selected candidate, unchanged winner, errors, missing observations and decision tradeoffs inspectable. Export a versioned prompt/criterion artifact with model compatibility and validation evidence. Publish a source-linked note with a small real code example and the limits of the result. The [separate checklist](../IMPLEMENTATION.md#gepa-domain-adaptation-existing-experiment-next-wave) tracks the work; this addition does not claim a new optimization result.
