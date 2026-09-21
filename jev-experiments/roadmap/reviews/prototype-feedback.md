I'll start by locating the key files referenced in the request.

**Review scope.** Read MAP.md, routing PROTOCOL/NOTES/ATTRIBUTION, integration evidence, run_harness.py, mcp.ts, execute.ts, router.ts, artifacts.ts, web-handler.ts, live-route.*, checks.json, clean-checkout.json, materials/playable code, design-research README, main.tsx, and all eight screenshots. Training and release gates remain open per MAP.md; nothing below assumes otherwise.

## Required fixes

1. **`verification/live-route.json` no longer reflects current code and has hand-added fields.** The recorded patch uses `--- sum.ts` headers and `@@ -1,5 +1,6 @@` with five added lines. `artifacts.ts:16,33` now rejects both (needs `a/`/`b/` headers, exact counts), so today's web handler would classify that response as `malformed`, not `ok`. Also `independentCheck.strictPatchApplied` and `hostRepair` (live-route.json:110-111) are not emitted by `live-route.ts:24`. Re-run the live route under current code and regenerate the JSON from the script; drop or justify the `--recount -p0` repair branch at `live-route.ts:21`, which now contradicts the strict validator and silently accepts arithmetic the artifact layer rejects.

2. **Harness evidence does not include the transcripts the protocol requires.** PROTOCOL.md:19 says "Store redacted transcripts." `run_harness.py:58` writes `stdout.jsonl`, `stderr.txt`, `mcp-audit.jsonl`, `host.diff`, `tests-after.txt`, but none exist under `integration/evidence/*`. The only record of delegation is `summary.json.toolCalls`. Commit the sanitized audit/transcript files (or state why they were withheld) so "delegation actually occurred" is verifiable rather than asserted.

3. **`mcpDiscovered` measures initialization, which PROTOCOL.md:17 explicitly calls a failed gate.** `run_harness.py:57` sets it from any `tools/list` event. `codex-approval-default/summary.json` shows `mcpDiscovered: true`, `toolCalls: []`, `patchedBug: true`, `exitCode: 0`—a host that fixed the bug itself with zero delegation, yet its summary reads like a pass. Add an explicit `delegationOccurred` (≥1 `tools/result` with `status: ok` and an artifact) and mark variant folders as failures in-file, not only in `playable/review/README.md:14`.

4. **`integration/NOTES.md` is empty and there is no integration README.** Five evidence folders exist (three passes, three failure variants) with no index stating which is which, host model per run (Claude host was `claude-sonnet-4-6` after `claude-fable-5-1` was unavailable; Codex host model is unrecorded), CLI versions (only in routing/NOTES.md:2), or run order. `codex-approval-default` also points `JEV_MCP_AUDIT` at `evidence/codex/mcp-audit.jsonl` (summary.json:19), so it may have clobbered the passing Codex audit before renaming. Write the index and record host model/version per run.

5. **Review bundle omits files the shipped code depends on.** `main.tsx:43` imports `../../roadmap/credits`; MAP.md links `decisions/*.md`; clean-checkout.json runs `roadmap/apply.sh` and `bun install` in `roadmap/`. None are present here. Builds pass in checks.json, so this is probably an export gap, but public footer attribution (`BuilderCredits`, design-research README:63 "credit model, playground and scoring method separately") cannot be verified. Include these files or attach the rendered credits text for review.

6. **Duplicated executor with divergent validation.** `web-handler.ts:16-27` re-implements the openai-compatible path of `execute.ts:18-30`. The web copy lacks the non-negative usage checks and cached-token clamp at `execute.ts:24`, which `playable/review/README.md:13` already flagged. After two integrations this is the duplication MAP.md:21 says to review: extract one executor parameterized by endpoint/key and use it from both.

7. **`executeOpenCode` inconsistently reports cost.** `execute.ts:56` returns `costUsd: null` on `ok` but `cost(route,usage)` on `malformed`. PROTOCOL.md:33 says the OpenCode delegate reports cost null. Make both branches null.

## Optional suggestions

8. `mcp.ts:42` uses `void handle(...)`; a throw outside the inner try (e.g. `appendFileSync` audit failure at line 15) becomes an unhandled rejection and kills the server. Wrap `handle` or catch the promise.

9. `ModelRoutingLab.tsx:28` calls the recorded patch "correct." Link that word to the independent test record for the recorded run, and state plainly that the live web demo uses Gateway routes (`gpt-4.1-mini`, `claude-haiku-4.5`), not the recorded Bedrock/OpenCode destination.

10. `run_harness.py` can no longer reproduce the failure-variant folders (no `--dir`-less OpenCode path, no Codex default-approval path). Either add flags that reproduce them or note in the index that they are historical.

11. `IMPLEMENTATION.md` shows CI, MCP, harness and materials items unchecked despite evidence existing; update it so status matches MAP.md's "In progress" rows.

12. `opencode-cwd-timeout/generated-fixture/` shows the agent wrote into the repository when `--dir` was missing. The fix (`--dir`) is in place; consider narrowing `write`/`edit` permission to the fixture path in `run_harness.py:37` as defense in depth.

## Observations that hold up

- Hard-policy separation (classify → eligibility → selection → execute → outcome) is respected in `router.ts`; no branch widens tools, locality or budget. Simulated prices are rejected under hard caps (`policy.ts:85`), and the web route defaults to a configured-price cap.
- Async invalidation in `MaterialsSandbox.tsx:19-40` and `live-crowd.tsx:176-194,330,356-358` uses revision/epoch tokens plus abort; tests cover the pre-comparison stale case.
- Local vs Jev is labeled correctly in the crowd mobile screenshot ("Keyword baseline, not Jev", "Local notice rules") and materials footer ("Manual controls" vs "Accepted live Jev proposal"). Music screenshot shows only "Playback started," consistent with README's caveat that it does not establish listening.
- Screenshots confirm layout at mobile and desktop widths only; animation, reduced-motion behavior and the running tick on the home scene are not evaluable from stills.
- Public copy on the routing page marks quality/latency as simulated and prices as dated list values; the footer disclaims TypeSafe affiliation.
