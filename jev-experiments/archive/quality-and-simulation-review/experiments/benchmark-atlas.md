# The next experiments

Verdict: research-map. Highest priority: P2. This is an honest research shortlist with useful questions. Its next job is to turn those questions into versioned, executable plans. It is not a benchmark result and should not receive an accuracy score.

## Current boundary and strengths

`local-models-and-games/research.ts:2` authors eight benchmark cards and `:111` authors twelve product ideas. It writes prose and links to `research-map.jsonl`; no model participates. `experience-prototypes/src/local-models.tsx:572` renders tabs, category filtering, protocol folds and links. The visitor can read or navigate, but cannot configure or execute a study. The decision boundary is therefore entirely editorial and deterministic. Paths below are relative to `jev-experiments`.

The decoded record contains nineteen Proposed entries and one Implemented entry, Typed Decisions, which links to the actual local-model comparison. The UI explicitly says proposals imply no scores or completed runs. Every card names a question, suggested demo, protocol, measure and limitation. Source: `research.ts:96`, `:264`; `local-models.tsx:592`, `:640`. Existing caveats correctly distinguish retrieval from verification, intent from slots, model decisions from audio synthesis and structured state from pixels. The research and record files match frozen main `4c0c40d5`.

## Findings

### P2: prose cannot establish whether a future run is complete

None of the twenty entries has a structured ID, revision, split, expected case count, scorer, seed, request budget or evidence path. Only BoolQ and Typed Decisions state an explicit evaluation count in their protocol text. This is reproduced by [the original record probe](../probes/benchmark-atlas.ts), with [counts](../probes/benchmark-atlas.json).

That is acceptable for a reading list, but it leaves no test for promoting a 100-case sample to "Implemented". Add a typed run contract with expected IDs, dataset/config revision, split, scoring version and evidence linkage. Derive statuses such as planned, setup-verified, running, partial and complete from actual artifacts. Keep implemented interface status separate from complete benchmark coverage. A card's display name should not be its persistent identity, as it currently is at `local-models.tsx:630`.

### P2: version and access assumptions are not recorded

MASSIVE's card says 51 languages without naming a version at `research.ts:59`. Its linked primary project distinguishes 1.0 with 51 from 1.1 with 52, after adding Catalan. The official dataset card lists 2,974 test utterances per language, making the two full test sizes 151,674 and 154,648. This is an unresolved version choice, not proof the 51-language proposal is wrong. [MASSIVE source](https://github.com/alexa/massive), [dataset card](https://huggingface.co/datasets/AmazonScience/massive).

WildGuardMix currently requires acceptance of access conditions, while SciFact's released test labels are not public in its documented workflow. The atlas mentions licenses and sensitive content but has no explicit access or scoring blocker state. Source: `research.ts:47`, `:74`; [WildGuardMix card](https://huggingface.co/datasets/allenai/wildguardmix), [SciFact runner documentation](https://github.com/allenai/scifact). Record verified date, source revision, access method and whether results can be independently scored before scheduling work. No access terms were accepted for this audit.

### P2: some proposed metrics change the task being claimed

SciFact's card proposes label F1 and evidence precision/recall, without naming its official abstract/rationale scoring variants. The official task evaluates evidence document and sentence sets with label-dependent credit and special rationale rules; a three-way classifier given gold evidence is a separate, useful condition. Source: `research.ts:42`; [official evaluation rules](https://raw.githubusercontent.com/allenai/scifact/master/doc/evaluation.md). Its loader can expose multiple rows for one claim, so "all rows" can also inflate the independent denominator.

AgentDojo similarly requires executing the acting agent and checking both clean utility and attack outcomes; labeling hostile-looking snippets cannot stand in for that. The card already identifies actual final outcomes at `research.ts:87`, but no pinned task/attack matrix or tool budget makes the experiment concrete. Define input, unit of evaluation, official scorer and assisted variants for every card. Keep classification proxy scores visibly separate from end-task results.

### P2: all proposals look equally ready to build

The only filters are tab and category, and every proposal uses the same card treatment. There is no effort, dependency, request volume, evidence gap or next deliverable. Source: `local-models.tsx:573`, `:621`. A 3,270-question binary classifier and a multilingual 151,674-utterance run are different undertakings. An AgentDojo study also spends acting-model calls between Jev decisions.

Add a selectable study tray with transparent counts and prerequisites. Start with BoolQ and PAWS for bounded classifier checks, then ANLI. Gate SciFact on scorer parity and evidence protocol, WildGuard on access, and AgentDojo on sandboxed end-task evaluation. Product ideas should specify the user action and acceptance condition that adds value beyond their paired benchmark. The atlas itself needs code for this planning interaction, not a model call to invent authoritative counts.

## Verified coverage and execution plan

The seven proposed benchmark cards have zero recorded predictions in this atlas. Typed Decisions links to a completed 400-case external test comparison. These are separate denominators. The following counts were checked against primary sources; they are proposed future workloads, not audit executions.

| Entry | Full named unit | Scoring and feasibility |
| --- | --- | --- |
| [BoolQ](https://github.com/google-research-datasets/boolean-questions) | 3,270 labeled development questions; 3,245 separate unlabeled test questions | Use all labeled development items as a declared evaluation, with no tuning on them. Accuracy is primary; fit calibration only using training data. One yes/no decision per case. |
| [ANLI](https://huggingface.co/datasets/facebook/anli) | Test R1 1,000, R2 1,000, R3 1,200; total 3,200 | Report accuracy by round and pooled, macro recall as an extra. Input only premise and hypothesis; exclude the label and annotator reason. One three-way decision per pair. |
| [PAWS-Wiki Labeled Final](https://github.com/google-research-datasets/paws) | 8,000 test sentence pairs | Binary accuracy and false-positive rate; lexical-overlap and majority baselines. Keep Wiki separate from restricted QQP reconstruction. One decision per pair. |
| [SciFact original release](https://aclanthology.org/2020.emnlp-main.609.pdf) | 300 labeled dev claims; 300 unlabeled test claims; corpus 5,183 abstracts | Start with all 300 unique dev claims and pin the oracle-abstract condition. Official test scoring requires its submission route. Full retrieval and supplied-evidence classification need separate outcomes. |
| [MASSIVE](https://huggingface.co/datasets/AmazonScience/massive) | 1.0: 51 × 2,974 = 151,674 test utterances. 1.1: 52 × 2,974 = 154,648 | Choose a version. Score intent accuracy plus per-language macro F1; no slot claim from intent-only output. Bootstrap parallel languages by shared utterance ID. Out-of-scope cases are an additional authored set. |
| [WildGuardTest](https://huggingface.co/datasets/allenai/wildguardmix) | 1,725 test items, up to three annotated tasks per item | Prompt harm, response harm and refusal require separate valid-label denominators. Up to 5,175 typed decisions per full pass. Access conditions are a current setup blocker. |
| [AgentDojo](https://arxiv.org/abs/2406.13352) | Original paper reports 97 realistic tasks and 629 security test cases | This is an executable environment, not a fixed classifier table. Pin suite/attack versions and enumerate valid task/attack pairs before giving a current full-run count. Record acting-model turns and Jev tool-result decisions separately. |
| [Typed Decisions](https://huggingface.co/datasets/LocalLLaMA/typed-decisions) | 400 test cases × five questions = 2,000 decisions per model, already linked | Preserve specialist/generalist labels and synthetic-teacher scoring. The atlas should link its evidence manifest rather than duplicate mutable scores. |

A first complete tranche of BoolQ, ANLI and PAWS contains 14,470 cases per policy. Three hosted repeats require 43,410 logical decisions. With verified batches of 20 independent cases this is 2,172 requests before retries, allowing one partial batch per benchmark per repeat. A full MASSIVE 1.0 intent pass adds 151,674 logical decisions before repeats. This makes batching, persistence and provider limits part of the plan rather than an afterthought.

Each run should freeze exact IDs and source/scorer hashes before inference, retain raw decisions and failed attempts, resume by immutable request fingerprint and publish completed/failed/pending coverage. Compare majority and lexical rules with appropriate local models and Jev, using the same visible evidence. Report numerator/denominator, missing outputs, paired differences and case/source-clustered intervals. Calibration and prompts use development data only; label-order variants are diagnostics, not opportunities to choose the best test result. Public pretraining exposure remains an unresolved confound. Provider availability is a separate result from task accuracy.

## Richer interaction: a study planner with inspectable evidence

A visitor selects BoolQ, adds Jev and a local model, and sees the exact 3,270-case plan, source revision, scoring unit and estimated request count. Selecting a small pilot creates a visibly partial plan. Before running, they inspect an example with hidden gold, predict its answer and reveal the existing baseline evidence. They can compare the full plan with an alternative observation condition and export a reproducible manifest. An existing result opens a coverage ledger showing missing and failed IDs.

Code owns dataset metadata, hashes, split membership, budget arithmetic, status transitions and scoring. Jev has no necessary role in planning; it answers benchmark questions only when a separate execution action starts a recorded run. A model may suggest which hypothesis to test, but code must never accept its invented dataset counts or scores as evidence. Job state includes planned IDs, request fingerprints, queued/running/completed/failed states and artifact hashes. Cancellation keeps completed rows and marks remaining work pending. Restart cannot duplicate accepted decisions or silently discard failures.

Acceptance criteria: a 100-case pilot cannot display full coverage; a wrong revision or duplicate/missing ID fails publication; an interrupted run resumes to the same declared set; all displayed totals match the exported manifest; labels and reasons stay outside model input; category/model/budget changes preserve the selected study; and keyboard users can inspect coverage and provenance without relying on animated cards.

## Useful libraries and priorities

[Hugging Face Datasets](https://huggingface.co/docs/datasets/loading) supports explicit configs, revisions and split loading. Use it to build immutable ID manifests; do not treat a loader's expanded row count as an independent case count. [Zod](https://zod.dev/) can validate the atlas/run contract in the Bun tooling and browser. Neither supplies semantic judgments; Jev belongs in the selected evaluation pipeline.

P2/S: add stable IDs and verified split/version/access metadata for all eight benchmark cards. P2/M: validate manifests and derive evidence status from files. P2/M: implement scorer parity fixtures and complete the BoolQ/ANLI/PAWS tranche after an explicit run budget. P2/M: build the study tray, partial-coverage ledger and export action. P2/L: add the sandboxed AgentDojo extension only after clean utility and attack checks work. This planner can later schedule the real-time games' seed/goal/latency matrices without confusing a short demonstration with full coverage.

## Investigation log

Read the frozen authoring source, decoded complete record, publication mapping and ResearchMap component. The original Bun probe counts all twenty entries and missing structured fields; it makes no requests. Verified primary dataset counts, versions, official task/scoring distinctions and access blockers online. No benchmark was run, no dataset corpus or model weights were downloaded, and no browser interaction, app edit or commit occurred. Failed raw-document reads were followed by primary dataset cards or direct small README fetches.
