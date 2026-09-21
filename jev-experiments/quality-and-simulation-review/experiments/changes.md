# Change impact — dedicated audit

**Verdict: repair. Highest priority: P1.** The current evidence is one authored venue change and four judgments, all matching a dependency lookup that can be computed from metadata supplied to Jev. The interaction is useful, but this record does not demonstrate independent semantic impact detection. An actual-callback probe also reproduces old judgments attaching to a newly edited fact.

Paths below are relative to `jev-experiments/`. Reproduction: `bun jev-experiments/quality-and-simulation-review/probes/changes.ts` from the repository root. The probe executes current component callbacks with mocked React hooks and a deferred response; it does not use a browser or model.

## Current purpose and evidence

The catalog asks whether source edits invalidate conclusions (`experience-prototypes/src/catalog.ts:102`). The visitor changes one of three event facts and sees four fixed conclusion cards. Jev returns one Noul score per conclusion; code compares it with 0.5 and chooses a badge/style. Code owns the before/after object and fixed cards, but does not compute or display a dependency comparison (`src/new-experiments.tsx:786`, `:836`, `:899`).

`publication.json:4` points to `results/changes.jsonl`. Its entire decoded result contains one successful 300 ms request, one provider attempt, no retries, and scores travel 0.95, calendar 0.84, catering 0.09, reminder 0.09. Probability/confidence metadata are null. The runner changes Seattle to Portland while retaining date and capacity (`scripts/record.ts:90`). There are no recorded date, capacity, no-op, spelling, or compound-change cases.

Useful foundations already work: stable conclusion IDs, readable before/after text, immediate clearing of badges after a draft edit, a busy/error wrapper, and an inspectable state panel (`new-experiments.tsx:827`, `:874`, `:888`, `:919`). The live gateway validates every requested answer and rejects missing or malformed responses (`server/gateway.ts:189`). No Changes-specific automated test was found in the current source/test search.

## Findings

### 1. P1: The claimed independent check is supplied to the model

Each conclusion contains a `depends` array. Both recorder and live UI send the complete objects, including all five dependency edges (`new-experiments.tsx:795`, `:800`, `:805`, `:810`, `:903`; `record.ts:97`). The interface calls the authored list an independent check (`new-experiments.tsx:867`).

The probe reconstructs all four saved threshold decisions using only `depends.some(field => before[field] !== after[field])`. No sentence interpretation is necessary for this venue replacement. This is evidence of an available shortcut, not proof that Jev causally used it. The UI also never computes a comparison with the list outside the raw inspector.

For semantic evaluation, remove dependency annotations from model input and keep them with independently reviewed labels. If known dependencies are an intentional product input, show the deterministic propagation baseline and describe Jev's separate task: deciding whether the textual change materially affects a conclusion. Test annotation-free, supplied-graph and shuffled-graph conditions separately; do not describe a supplied graph as held-out evidence.

### 2. P1: An old response becomes the judgment for a new draft

Input changes clear `answers`, but the request callback unconditionally calls `setAnswers` and `setLast` when it completes (`new-experiments.tsx:875`, `:889`, `:914`). `useRun` manages busy/error state, not request identity (`shared.tsx:214`).

The actual callback probe starts the default venue request, changes the draft to October 20, then resolves the original record. Travel remains flagged and the reminder remains unflagged: two of four cards conflict with the supplied dependency baseline for the displayed date change. Even before completion, the inspector pairs the edited draft with the old `last` record.

Bind a response to immutable before/after/conclusion hashes and a draft revision. Abort obsolete work when possible and reject late commits regardless of cancellation success. Show the submitted snapshot with each historical run; an edited draft must not silently relabel it. Preserve old runs in history if useful.

### 3. P1: “Still supported” overstates what a negative or missing judgment means

The question asks whether review is needed; the negative badge asserts support (`new-experiments.tsx:909`, `:852`). No separate support check or evidence span is requested. A synthetic record containing only `travel` makes all three missing answers display “Still supported,” because an undefined score fails the threshold comparison. The published record itself is complete, and the gateway rejects incomplete live output; this is a reproduced UI boundary defect, not a claim about a failed provider response.

Use explicit unevaluated, pending, failed, stale, flagged and not-flagged states. Label a negative result “Not flagged by this check.” If support is a separate product claim, evaluate it from evidence and retain unknowns. Exact score values belong in the inspector with their protocol label, not a confidence claim.

### 4. P1: Recorded provenance is incomplete and the live protocol has drifted

The saved result contains answers/provider metadata but no exact state, questions, fixture hash or protocol version (`record.ts:18`; decoded `results/changes.jsonl`). The UI attaches these scores to current constants. Its live prompt adds “Ignore spelling-only changes,” absent from the recording prompt (`new-experiments.tsx:909`; `record.ts:103`). The recorder skips any existing file without checking protocol compatibility (`record.ts:27`).

Keep the original record, but label its reconstructed context as reconstructed from current runner source. Future records need exact submitted inputs, question/order versions, hashes, threshold policy, and case-level status. Generate live and recording requests through one pure builder. One successful fixture establishes availability for that request, not accuracy, calibration, or savings across change types.

### 5. P2: The workflow stops at four badges and has undefined edit boundaries

The visitor cannot inspect a causal path, repair a conclusion, accept a revision, or compare successive edits; all changes are against the original constants (`new-experiments.tsx:813`). Switching a field clears its value, yet an empty replacement is submit-able. The probe also submits an exact no-op. Neither behavior is intrinsically wrong, but deletion and no-op semantics are undeclared and untested. A raw string dependency lookup will flag a spelling-only change even though the live prompt says to ignore it.

Distinguish replacement, explicit deletion and no change. Short-circuit exact no-ops in code; retain meaningful deletions as explicit unknown facts. Add a review queue linked to the changed facts, supporting text and scoped human decisions. A static dependency list should explain where to look, while semantic equivalence and conditional support remain separate judgments.

## Richer workflow: an event plan that stays current

Open an event brief beside its invitation, travel note, catering order and reminder. Change venue and date in a draft. The graph highlights structurally reachable items immediately; a second layer marks Jev's semantic review decisions. Clicking a card reveals the exact changed text and the evidence supplied for that judgment. The visitor edits the conclusion or marks it reviewed, then commits a new plan revision. A timeline can restore the old revision and fork an alternative venue without overwriting either history.

State includes immutable fact/conclusion revisions, declared dependency provenance, exact runs, per-conclusion status and version-scoped human overrides. Code owns diffs, stable IDs, known-edge reachability, date arithmetic, invalidation, queue order, exports and transaction history. Jev handles semantic impact when textual equivalence, indirect references or conditions cannot be decided by the declared rules. Known graph edges and human gold annotations must remain distinguishable.

Failures remain visible: missing facts yield unknown status; provider errors leave the deterministic candidate set available; late responses cannot update another revision. Editing a conclusion invalidates only the corresponding judgments. A keyboard-accessible list accompanies the graph.

Acceptance criteria: zero wrong-revision commits; every badge/override/export has a source revision; reverting a fact restores the correct comparison without overwriting history; no-op changes request zero judgments; missing/failed results never imply support; code-derived reminder dates agree with the selected calendar date; and only affected current items enter the review queue. These are proposed criteria, not implemented results.

## Evaluation protocol

Keep the original scenario as a demonstration. Author 64 independent document packs, each with eight conclusions and eight edits: exact no-op, formatting/typo, meaning-preserving rewrite, direct replacement, derived date/quantity change, irrelevant new fact, deletion/contradiction, and a compound edit. Reserve 16 packs for development and 48 for testing, split by scenario/template family. Two reviewers independently label material-review need, support/unknown status, and relevant evidence; adjudicate disagreements without exposing the labels or dependency annotations to the primary model condition.

The held-out set has **384 changed snapshots and 3,072 conclusion decisions**. Compare an annotation-free primary protocol for three unchanged passes, a supplied-graph diagnostic, and a shuffled-graph diagnostic. This plans **15,360 primitive decisions and 1,920 eight-question requests**, before payload splits/retries. It is authored evaluation, not an external benchmark; no official external split or score is claimed. Requests require a later explicit recording run and provider capacity. Freeze hashes and retry only transient failures, preserving wrong answers.

Baselines: flag everything, flag nothing, a frozen changed-text overlap rule with declared normalization, and exact supplied-graph propagation reported as a different information condition. Date/quantity formulas provide independent checks where their assumptions are fully specified. Do not use a gold dependency graph as an unlabelled advantage in the annotation-free comparison.

Report precision/recall of material review, exact affected-set accuracy per edit, unnecessary reviews on no-ops/rewrites, unknown-support coverage, repeat/order disagreement, and diagnostic sensitivity to dependency metadata. Publish per-stratum and per-pack counts, all-scheduled/provider-completed denominators, retries, latency and cost. Use 10,000 paired bootstrap resamples clustered by the 48 base packs; eight edits and eight conclusions from one pack are not independent samples. Keep 0.5 frozen for the initial comparison; tune any new threshold only on the 16 development packs. A provisional gate is at least 90% recall lower confidence bound on determinate affected conclusions with no more than 10% false review on semantic no-ops; publish both even if the gate fails.

Separately run 1,000 offline schedules across seeds 0–99, ten edit/response/revert/delete patterns each. Require zero wrong-revision commits, missing-as-supported states or export-version mismatches. A later counterbalanced reviewer study is needed before claiming time savings; model accuracy alone cannot establish that.

## Libraries and next steps

- [React Flow computing flows](https://reactflow.dev/learn/advanced-use/computing-flows), already installed through `@xyflow/react`, supplies nodes, edges and connected-data views. Keep canonical revisions outside transient graph input state; its documentation notes update delays for controlled inputs. Jev contributes semantic impact on top of visible deterministic reachability.
- [jsdiff](https://github.com/kpdecker/jsdiff) supplies word/whitespace diffs for before/after evidence. A text diff locates changes; it does not decide whether their meaning changes.

P1/S: remove the independence claim or withhold annotations, repair request identity/statuses, share the request builder and save exact payloads. P1/M: add independently labeled change families and the declared metadata ablations. P2/M: build the revisioned review queue with graph/list views, evidence and scoped overrides. The same engine could support document review after policy updates, where known references narrow the candidate set and semantic checks determine which conclusions require attention.

Investigation: read current catalog/component/helpers/runner/publication/tests; decoded the complete JSONL with `readRecord`; hashed source inputs; executed probe assertions including leaked-graph reconstruction, stale completion and missing-record behavior; verified two primary library sources. No browser, app edits, model calls or commits.
