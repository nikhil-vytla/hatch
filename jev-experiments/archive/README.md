# Archive

Dated audits, reviews and one-off studies from the first release (19–30 Sep 2026). Nothing here is built, deployed or run in CI. It's kept as the record of how decisions were made. The files were moved here unchanged on 2 Oct 2026, so paths inside them still point at their old locations, for example `jev-experiments/security-audit/`. Read those as `jev-experiments/archive/security-audit/`.

| Folder | Dates | What it records |
|---|---|---|
| [capability-atlas-2026-09-22](capability-atlas-2026-09-22/) | 22–30 Sep | An audit of how each experiment used Jev: inputs, questions and evidence bindings. Retired on 2 Oct, when it no longer matched the site. `/capabilities.html` now shows a retired notice. |
| [creative-interaction-research](creative-interaction-research/) | 20 Sep | Sixteen creative-coding and explorable-explanation works (Red Blob Games, Nicky Case and others) behind the direction for the playable scenes. |
| [ifeval-review](ifeval-review/) | 20 Sep | A review of a proposed IFEval response-selection experiment, which found problems in the checker and was not run. |
| [merge-readiness](merge-readiness/) | 20 Sep | The review that made PR #54 safe to merge: visitor-owned gateway keys, request validation, companion URL privacy, and converting results to JSONL. |
| [native-questions-2026-09-22](native-questions-2026-09-22/) | 22 Sep | Structured instructions and criteria preserved through the language adapters, plus a Go and Rust validation fix with failing-before and passing-after checks. |
| [publication-lineage-2026-09-22](publication-lineage-2026-09-22/) | 22 Sep | Explicit derivative lineage for the RewardBench 2 publication records. |
| [quality-and-simulation-review](quality-and-simulation-review/) | 20 Sep – 2 Oct | Reviews of all 33 original experiments (160 findings), with the probes and reports. Its `review.html` is still published at `/research/quality-review/`, from a copy committed in `experience-prototypes/public/research/`. |
| [real-time-playground](real-time-playground/) | 20 Sep | A flight game and crowd simulation exploring asynchronous decisions while a world keeps moving. Its explainer is still published at `/research/show-me-realtime.html`, from a copy committed in `experience-prototypes/public/research/`. |
| [request-provenance](request-provenance/) | 20 Sep | Where Experiment 28's prompts came from: an IFEval sample with seed 42, plus authored creative prompts. |
| [security-audit](security-audit/) | 20 Sep | A credential and exposure audit of the first Jev lab PR, and the JSONL proposal that shrank its largest files. |
| [semantic-benchmark-selection](semantic-benchmark-selection/) | 20 Sep | Why RewardBench 2 replaced the IFEval writing-selection experiment. |
| [site-footer-2026-09-22](site-footer-2026-09-22/) | 22 Sep | The footer change to the TypeSafe AI independence statement. |

## Still at the top level

These dated folders stay where they are, because live code, CI or deployment notes depend on their paths:

- **`gateway-accounting-2026-09-22`:** its tests run in `jev-gateway.yml` and in the typed-runtime verifier.
- **`release-implementation-2026-09-22`:** its source, revision and notes tests run in `jev-site.yml`, and notes link to it.
- **`scene-lifetimes-2026-09-22`:** its lifetime tests run in `jev-site.yml`.
- **`typed-runtime-2026-09-22`:** its own workflow, `jev-typed-runtime.yml`, verifies an exact archive of the current commit with these paths.
- **`vercel-git-root`:** AGENTS.md and `roadmap/verification/canonical-deployment.py` cite it.

`artifacts/` holds the SmolLM pilot weights that `src/jev_lab/replica_infer.py` loads, and `agents/adrs/` holds the architecture decision records. Both are reference material rather than dated audits, so they stay too.
