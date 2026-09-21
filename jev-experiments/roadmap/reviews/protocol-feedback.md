# Independent review: training/PROTOCOL.md + routing/PROTOCOL.md

**Verdict: NOT RELEASABLE as evidence yet; protocols are releasable as frozen designs after the required fixes below.** No manifest, trained model, export, or harness transcript exists in this snapshot, so nothing here is measured evidence. Findings are ordered by severity; disposition is one of **BLOCK** (must fix before any result claim), **FIX** (cheap, do before first run), **DISCLOSE** (state in protocol/release copy), **OPTIONAL**.

## Training study

**1. Cross-split content leakage is unchecked (BLOCK).** `prepare.py:163-168` rejects duplicate *IDs*, which cannot collide by construction (`banking77/train/i` vs `banking77/test/i`). It never checks duplicate *content*. BANKING77 has known duplicate utterances across train/test; BoolQ shares passages across rows; STS-B shares sentences across splits. Fix: hash `canonical(state)+canonical(question)` and fail (or exclude from train/validation, keeping test) on any cross-split match; record counts in the manifest.

**2. SummEval transfer will self-destruct on the 768-token limit (BLOCK).** `prepare.py:119` puts the full source document *plus all 11 `human_summaries`* into state. With a 768-token cap and no truncation, coverage will be near zero and the gate fails by design, not by model weakness. Protocol says "reference" (singular). Fix: include zero or one reference (fluency does not need references); freeze this before the manifest. Also `r.get('text','')` silently produces empty sources; use `r['text']` and fail loudly, as the protocol's "coverage is zero and the gate fails" clause intends.

**3. Priors on unseen values/scales are undefined (FIX).** "State-blind per-kind priors ... align by semantic value." For choice, CLINC and Typed Decisions labels are unseen; for ordinal, Typed Decisions uses index scales `0..len-1` (`prepare.py:136-137`) and SummEval uses 1..5, not STS-B's 0..5. Define: uniform fallback for unseen values; ordinal prior aligned on normalized position or declared uniform; report which applied per row. Without this, the prior baseline's transfer numbers are unreproducible.

**4. Second candidate text form is unspecified (FIX).** Protocol promises "two semantically identical textual forms"; code has only `replace('_',' ')`. Specify both forms and pin them in the manifest so the augmentation is auditable.

**5. Semantic identity bug in Typed Decisions choice targets (FIX).** `prepare.py:139` uses `str(v).lower()` for all kinds. For choice keys with uppercase characters this either KeyErrors or collapses case-distinct options. Lowercase only for boolean; use exact keys for choice.

**6. Laya provenance vs held-out sets (DISCLOSE/BLOCK for Laya rows).** The "published Laya encoder/scorer" is a comparison condition, but its training data is not declared relative to Typed Decisions test, CLINC, MultiRC, SummEval. If Laya saw Typed Decisions train, its transfer row is not held-out. State overlap per dataset; mark affected cells as non-held-out. Also disclose that SmolLM2/Qwen3 pretraining may contain BoolQ/STS-B/BANKING77.

**7. Export gate can be satisfied by a readout-only artifact (FIX).** ≥99% agreement / ≤0.02 max error is checked on outputs only. A Core ML readout fed MLX embeddings passes. Require and record: the artifact's input spec is token IDs (not embeddings), its output is the final masked probability vector, its parameter count ≥ backbone size, and its SHA-256. State which compute-unit condition (CPU_ONLY or ALL) the default-selection gate uses. Pin the timing inputs (fixed validation IDs) for the 30-rep warm median.

**8. Adapter limits must reflect protocol limits (FIX).** `DEFAULT_LIMITS` is 128 questions / 255 options; protocol is 32 / 8 / 768 tokens. The MLX and Core ML adapters must override `RuntimeLimits` and check `maxTokens` pre-inference, with rejects counted in coverage. Not yet implemented; do not report coverage until it is.

**9. Validation reuse (DISCLOSE).** The same 192 validation rows select recipe, temperature, and installed default. Acceptable given separate test, but state it.

**10. Scope of "general" (DISCLOSE).** Three adaptation datasets × 256 rows is not a general typed-decision model. Release copy must say "readout adapted on three datasets" and never quote BANKING77/STS-B/MultiRC as their original benchmarks (protocol already says this; enforce in copy).

## Routing

**11. NaN/undefined route limits pass hard checks (BLOCK).** `policy.ts:49-50`: `route.contextTokens < bound` is `false` when `contextTokens` is `undefined`/`NaN`, so a malformed registry entry is *eligible* for any input. Same for `maxOutputTokens`. There is no `validateRoute`. Fix: use `!(route.contextTokens >= bound)` and add registry validation (finite limits, valid endpoint, `local` ⇔ loopback) at load, not only at execution (`execute.ts:20`).

**12. Classifier can broaden locality (BLOCK).** `router.ts:8-9` invokes `options.classifier(task)` with full context before `localOnly` is consulted. A hosted classifier under a local-only policy exfiltrates the task. Fix: classifier carries `{local, source}` metadata; refuse non-local classifiers when `policy.localOnly`, and record classifier identity/latency/cost on failure paths too (line 10 currently reports the heuristic classification with `source:'heuristic'` after a hosted classifier failed).

**13. Classification does not influence selection (DISCLOSE; BLOCK for any classifier-comparison claim).** `selectRoute` never receives `classification`. Heuristic/host/hosted/local conditions therefore produce identical routing; the comparative gate (protocol §Comparative evaluation) is vacuous under current code. Either wire classification into eligibility/ranking with a frozen mapping, or state that v1 measures classifier overhead only, never routing-quality differences.

**14. OpenCode destination conflates failure classes (FIX).** `execute.ts:53,57` map any nonzero exit and any `error` event to `unavailable`, enabling availability fallback on model/config/content errors and discarding produced text. Classify: rate-limit/overload/connection → `unavailable`; everything else → `error`. Also `actualModel` is the configured model, not the reported one.

**15. Token envelope is not conservative for OpenCode (FIX).** `inputTokenBound` adds a fixed 2048 (`policy.ts:32`), but the OpenCode agent path prepends OpenCode's own system prompt, which can exceed that. Use a destination-kind envelope and record the measured `usage.inputTokens` vs bound in evidence.

**16. `minimumQuality` accepts simulated quality (FIX).** `policy.ts:51` has no `basis==='measured'` requirement, unlike `maxLatencyMs` (line 52) and escalation (`router.ts:46`). Align.

**17. Latent budget bypass in escalation (FIX).** `router.ts:47` omits `remainingBudget`, so `selectRoute` falls back to the *full* `policy.maxCostUsd`. Currently unreachable because line 39 disables verification under any budget, but pass `remainingBudget` anyway. Also disclose: quality escalation is untestable under a hard budget in v1.

**18. `status:'ok'` with `failure` set (FIX).** `router.ts:39,45` return ok plus a failure string. Use a distinct `note` field so evidence tallies are unambiguous.

**19. Hard-limit accounting is otherwise sound.** Configured-price-only budget gating, cold-input reservation without cache discount, full-bound reservation on unknown charges, null-propagating totals, and classifier-cost requirement (`router.ts:17`) match the protocol.

## Contract

**20. `runtime/contract.ts` is fit for purpose.** Value-identity validation (not positional), full-coverage/sum-to-one checks, non-JSON rejection, and identity-mismatch handling in `execute.ts` support the option-order and reversal tests. OPTIONAL: guard `questionValues` against `min>max` before the range check message.

## Disposition summary

- **BLOCK:** 1, 2, 11, 12 (plus 6 and 13 for the specific claims they affect).
- **FIX before first run:** 3, 4, 5, 7, 8, 14, 15, 16, 17, 18.
- **DISCLOSE in protocol/release copy:** 6, 9, 10, 13.
- **OPTIONAL:** 20.

Items 1, 2, 5, 11, 16, 17, 18 are each a few lines. Nothing above requires expanding scope; 13 is the only item where the team must choose between narrowing the claim or adding a small frozen mapping.
