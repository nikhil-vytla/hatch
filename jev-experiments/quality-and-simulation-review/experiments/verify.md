# Agent verifier — dedicated audit

**Verdict: repair. Highest priority: P1.** Five short authored traces are each repeated four times; all twenty verdicts match their authored labels. This is a useful integration and repeatability check, not independent proof of completed work. Important evidence judgments are discarded, live behavior differs, and the editor can submit structurally invalid evidence without explaining the change in interpretation.

Paths are relative to `jev-experiments/`. Run `bun jev-experiments/quality-and-simulation-review/probes/verify.ts` to reproduce record counts, request/response comparisons and actual callback probes. No browser or new model calls were used.

## Current behavior and strengths

The experiment asks whether an agent's completion claim is supported by its visible trace. Jev selects verified, needs_check, violated_scope or contradicted; the recorded runner also asks a separate Noul question about direct evidence (`src/jev_lab/compositions.py:105`). Code renders the selected category and probability bars, without checking a repository, command, source URL or screenshot itself (`experience-prototypes/src/agent-experiments.tsx:296`). The claim is advisory: the result note explicitly says it does not authorize tool execution (`compositions.py:139`).

`publication.json:32` uses `../results/verify.jsonl`. All 20 requests completed across 24 attempts, including four rate limits. There are exactly five unique state bodies: parser tests pass; policy found; chart title changed without render inspection; prohibited file edits; failed import with a success claim. Each repeats four times (`compositions.py:75`). Targets are kept out of model input. The record honestly stores `independent_templates: 5`, and preserves all task/trace/claim text.

Verdict identities are stable in all five groups. Selected-category probabilities drift in three: return-policy 0.69–0.71, chart check 0.97–0.98, and scope violation 0.78–0.83. Parser remains 0.97 and import contradiction 1.0. These are measured repeat diagnostics; the simple narratives do not cover false-verification rates on realistic evidence.

## Findings

### 1. P1: Integration fixtures cannot establish verification quality

The runner duplicates five explicit narratives and reports row-level accuracy/calibration metrics (`compositions.py:73`, `:134`). The JSON discloses the repetition, but `AgentExperiment` displays twenty selectable records and generic request coverage without the independent-template count or the note (`agent-experiments.tsx:452`, `:465`).

No case distinguishes a claimed successful test from an actual tool receipt, an unrelated test from a relevant one, or a passing check on an old revision from the current artifact. The policy example literally says a source URL was recorded but supplies no URL. A semantic verdict can judge that narrative; it cannot authenticate an artifact it never receives. Keep the five as integration fixtures and group their repeats in the UI. Add independently checkable, versioned evidence before making stronger completion claims.

### 2. P1: Half the recorded decisions are discarded and live evaluation changes the task

Every recorded call requests `verdict` and `evidence`, and all 20 successful wire responses contain both. The row builder retains only verdict/probability/confidence, dropping **20 of 40 primitive answers** (`compositions.py:119`, `:125`). The live UI requests only verdict, with changed option descriptions (`agent-experiments.tsx:221`).

This loses the very diagnostic that could distinguish a completion category from direct-outcome evidence, and prevents visitors comparing the same protocol. Preserve both raw decisions with exact requests and evidence hashes; show agreement/disagreement without treating either as an independent correctness oracle. Share the live/recorded question builder. If simplifying to one question, freeze and record that as a new protocol rather than displaying older examples as equivalent.

### 3. P1: Old verdicts can replace a newly selected failed trace

Response completion unconditionally replaces `row` (`agent-experiments.tsx:261`). The probe starts parser verification, selects the failed-import example, then resolves the older verified answer. The selector/editor remain on import example 4 while the verdict panel returns to the parser's verified result. Its displayed task/trace are the older ones, so the result is internally traceable; the active selection is nevertheless inconsistent.

Version task, trace, claim and example selection together, and accept a response only for that version. Separate draft evidence from submitted evidence, visibly mark historical judgments, and retain a previous result without presenting it as the active assessment. Pending or failed checks must not inherit an earlier verified badge.

### 4. P1: Malformed structured input silently becomes a different claim

If JSON parsing fails, the UI treats the whole input as trace text and supplies a default completion claim (`agent-experiments.tsx:212`). The probe submits an unfinished object containing a review-only task and file-edit trace; the request has no structured task and has a generated default claim. Conversely, valid JSON `[]` passes through without task/trace/claim shape validation. No model behavior for these synthetic inputs was tested.

Provide explicit structured and plain-text modes. In structured mode, validate a nonempty task, claim and typed evidence list and show field errors. In plain-text mode, let the user specify the task and claim instead of inventing them. Distinguish quoted agent statements from tool-origin receipts and retain their provenance.

### 5. P2: One category conflates outcome, verification and scope

The four mutually exclusive labels mix different dimensions (`compositions.py:113`). An agent can complete a task while violating scope, or both violate scope and contradict its claim. The current five cases contain one obvious issue apiece, so they do not define precedence or reveal such overlap. The main panel shows task and trace but not the completion claim as a separate element (`agent-experiments.tsx:298`); it is available in the JSON editor/inspector.

Keep an inspectable completion claim and separate outcome support, verification relevance, and scope compliance. Code can derive a summary under a documented precedence rule; always retain the underlying axes and uncertainty. Scope compliance must not be inferred from a passed test, and missing evidence must not be equated with a proved failure.

## Richer interaction: a proof tray for one completion claim

Start with a tiny task and a claimed result. A timeline contains typed tool receipts, file revisions, assertions, screenshots or source excerpts. Remove one receipt, move it to an older revision, or replace the inspected artifact while preserving the same agent wording. The user predicts whether the claim remains supported, then sees Jev's judgment and deterministic checks side by side. Fork from the same task to compare a genuine completion, an unsupported claim and a scope violation.

Code owns event IDs, tool origin, timestamps, artifact hashes, explicit scope rules and predefined checks. It verifies exit status, artifact identity and test assertions where executable ground truth exists; it never runs arbitrary commands copied from trace text. Jev interprets whether supplied evidence is relevant to the natural-language goal and whether the stated claim exceeds it. The viewer explains missing evidence with references to visible events, not a fabricated chain of thought.

Acceptance: every judgment binds to task/claim/evidence revisions; invalid input triggers no request; a successful check on the wrong revision is marked insufficient by deterministic provenance checks; scope and outcome remain separate; old responses cannot replace an active trace; and failures/unknowns never become verified through missing values. Export the complete evidence and both deterministic/model outcomes.

## Evaluation protocol

Build 100 independent small task families with owned, reproducible artifact checks; reserve 20 for development and 80 held out. For each, produce eight labeled conditions: legitimate completion, missing verification, failed relevant check, unrelated/stale passing check, completed work with scope violation, narrative-only success, partial multi-objective completion, and combined scope violation plus failed work. Two reviewers label evidence relevance and claim support independently of Jev; executable assertions establish actual artifact outcomes. Keep all mutations of a task in one split.

The held-out set has **640 distinct traces**. Three unchanged passes of a direct verdict plus three evidence/scope questions yield **1,920 four-question requests and 7,680 primitive decisions**. Freeze the new protocol, summary precedence and thresholds before testing; keep original fixtures separate. Retain every response, including wrong verdicts, and record transport failures outside accuracy. No proposed collection was run.

Compare always-needs-check, a frozen lexical completion rule, and a structured deterministic provenance/assertion checker. Report false verified rate on unsuccessful/unsupported work, verification recall, needs-check precision, scope-violation recall, per-axis agreement, summary confusion and repeat flips. Evaluate benign claim paraphrases and injected instructions as separately labeled interventions. Use paired bootstrap intervals clustered by the 80 base tasks. A provisional gate is a false-verified upper 95% bound under 5%, with coverage and useful verification recall reported alongside it; the five original templates cannot support that conclusion.

Run 1,000 offline edit/select/claim-change/completion schedules over 100 seeds, requiring zero stale verdict commits or invalid-input requests. This is an authored evidence benchmark, not SWE-bench or an external task-success leaderboard: completion-claim support is a different target from solving repository issues. Independent reviewers and reproducible artifacts are the main setup cost; provider volume is modest in payload size but requires a later recorded run.

## Libraries and next steps

[Playwright assertions](https://playwright.dev/docs/test-assertions) can produce actual DOM/visual evidence for UI tasks, including awaited assertions tied to a known artifact version. They verify their specified conditions, not the whole natural-language task. [Zod](https://zod.dev/basics), already installed, can distinguish typed tool events, agent claims and malformed input. Jev contributes semantic relevance and claim interpretation above those checks.

P1/S: retain all raw answers, share protocols, validate input and guard request identity. P1/M: add task/claim/evidence provenance and independent artifact checks. P2/M: build the proof tray and the held-out mutation set with multi-axis outcomes. The same receipt model could support post-action checks in a bounded agent without treating a model verdict as authority to act.

Investigation: decoded every published row; compared all successful local wire responses; grouped exact states and measured score drift; inspected component/runner/helpers and found no verifier-specific UI test; executed stale-selection, malformed-object and array-input probes; verified primary library documentation. No app edits, browser checks, model calls or commits.
