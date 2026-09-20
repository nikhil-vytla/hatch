
## 2026-09-20, protocol freeze

Created this folder before implementation. Read JudgeBench, robustness and RewardBench 2 reviews. Applied the unslop writing skill. A review-path lookup initially missed because the folder is under jev-experiments; the papercut CLI declined logging because this repo has not opted in.

Pinned JudgeBench commit e2c52c284e735e139b3daa61c206ee208f36c461 already contains both complete splits locally. The official scorer credits positive combined signed votes after reversing the second vote. A null contributes zero, so a correct vote plus a null receives official credit even though availability is incomplete; both measurements must remain visible.

Frozen three sequential passes over all 620 pairs. Each pass interleaves both shared-pair orientations and two isolated-candidate states. Shared requests use the exact existing winner/a_correct/b_correct questions. Isolated requests put one candidate in state A and use the unchanged a_correct question, avoiding comparison context. That produces 7,440 logical requests and 14,880 question decisions. Scheduling seeds do not control model sampling. The provider documents independently evaluated questions sharing one state; unrelated states are never concatenated.

Content triage preserves prior reviewed sensitive flags by exact question hash and extends a conservative lexical scan over question and both complete answers. Triage is not claimed to be exhaustive human review. Flagged cases require a deliberate text reveal. Source text is rendered as text, never raw HTML.

## Native question batching revision

The original encoding completed only a small pilot before repeated shared-key rate limits and 18-second network timeouts made 7,440 individual HTTP requests wasteful. Archived that pilot unchanged under pilot/, including its protocol and attempt records. It is excluded from all comparative metrics.

Froze v2 before its first call. Each independently evaluated question now carries its complete JSON evidence in its instructions; state is one constant policy string. A pairwise question and each shared whole-answer question each receive the full pair. Each isolated question receives only its own candidate as A. These information sets are exact and repeat unchanged across the three passes. This protocol changes where context is encoded and cannot be pooled with historical state-encoded results. The provider's independent-question contract is the basis for the batching design.

Batches have at most 24 independent questions and 64,000 serialized bytes, with exact per-question hashes, whole-wire hashes and ID mappings retained. Maximum individual instruction length was checked against the gateway's 12,000-character limit. Three pilot native batches completed all 39 questions without malformed answers. Proceeded at one concurrent native batch and at least 1.1 seconds between batches because the music and cafe recordings share the same gateway key. Backoff honors the provider Retry-After via the existing gateway helper. Full 620-pair coverage, both orders, all three passes and all 14,880 questions are retained.

Seven tests currently cover all official tie/null vote combinations, canonical identity remapping, score drift versus answer flips, both source split sizes and all 268 question clusters, all byte-exact source candidates, labels absent from every model evidence object, matched prior content gates, and unchanged per-question evidence/hashes across repeats. 27,970 assertions passed. The new frontend component type-checks.

## Browser QA and integration

The shared result codec requires writeRecord; both analysis and preparation now write that format. The parent integrated JudgeBench and preparation on the existing judge route. Full app build passed. In v2, UI labels say “Pair-context scoring” because each independent question embeds pair evidence instead of placing that pair in the common state.

Used the Playwright skill in a separate judge-reliability session. On the integrated route at port 5193, verified all 620 pair options, labels and recorded matrix hidden before a vote, immutable first vote saved locally, labels still hidden after voting, explicit reveal, three matrix rows, both-order identity remapping, and two swaps restoring exact original text lengths and order. Exported pair JSON retained all three passes and its full original-text hash matched. A 390px viewport stacked the answer cards with no horizontal page overflow. Light and dark views were readable. A previously reviewed sensitive case mounted neither question nor candidate bodies before the content gate; deliberate opening mounted both complete answers while gold labels stayed hidden. The browser console had no errors. Desktop matrix and mobile dark gate screenshots are 78KB and 48KB.

A temporary isolated preview initially encountered Vite's outside-root serving restriction and then relative package-entry bundling errors. The repository has not opted into papercut logging, so these frictions are recorded here. The final browser checks used the integrated app route, not that temporary preview.

Paused recording at 142/7,440 evaluation records and 266/14,880 question decisions to let the simultaneous cafe/music recorders finish on the shared gateway key. Added safe rate-limit diagnostics using an explicit header whitelist and redacted error fields. Added a verification script that reconstructs every wire request, checks every per-question hash and mapping, enforces packing bounds, verifies original successful outputs, and asserts all official denominators. It passed on the current partial archive. New accepted batches save their full returned answer map before normalization, allowing crash recovery without rerunning accepted judgments.

## Recording handoff

Cafe completed all 102 evaluations and music finished its recording, so resumed v2 at one concurrent native batch with 1.1-second minimum spacing. A plain nohup child did not survive the command runner's process cleanup; launching through Python subprocess.Popen with start_new_session=True kept the background process alive. Verified PID 1025 running bun judgment-reliability/record.ts with stdout in the ignored recording.log. The first two resumed batches completed all 26 questions without errors. The parent will monitor the full run and regenerate verification.json, results.jsonl, README.md and _summary.md after all 14,880 decisions complete. Current committed summaries intentionally identify incomplete coverage.

- Added a bounded completion helper for the existing long-running recorder. `bun finalize.ts --wait-for-pid=PID` waits without making model calls, then requires full protocol verification before regenerating analysis and reports. It never commits or publishes incomplete output; `.finalization.json` records waiting, verified or needs-review state. Final publication remains a separate explicit snapshot after review.
