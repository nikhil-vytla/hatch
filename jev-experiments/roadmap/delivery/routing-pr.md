### Summary

Jev's routing experiment lacked a reusable delegation tool and evidence that coding clients could use its results. This adds a TypeScript API, Bun CLI and local MCP server that select an eligible destination, return a proposed artifact, and leave edits and independent tests to the calling client.

This slice depends on the preceding typed-runtime PR. Web components, public catalog integration and app/API wiring follow in the app PR.

<pr-train-toc>

- [Typed runtime](https://github.com/nikhil-vytla/hatch/pull/58)
- [Routing and client integration](https://github.com/nikhil-vytla/hatch/pull/59) (current PR)
- [Local study and Mac toolkit](https://github.com/nikhil-vytla/hatch/pull/60)
- [Playable scenes and design research](https://github.com/nikhil-vytla/hatch/pull/61)
- [Application and release evidence](https://github.com/nikhil-vytla/hatch/pull/62)

</pr-train-toc>

- `routing/policy.ts` and `router.ts` enforce hard restrictions before ranking. Fallback and escalation cannot widen them.
- `routing/index.ts`, `cli.ts` and `mcp.ts` expose `decide`, `route_task` and `classify_eml`. Default router baselines are labeled; its Mac bridge requires an explicit model ID. The separate Mac toolkit now defaults to the validation-selected experimental Laya readout.
- `routing/hooks.ts` validates callback identities and accounting. Unknown charges remain null. Callbacks are trusted caller code, not a network sandbox.
- `integration/` contains client setup, fixture runners and outcomes. `routing/artifacts.ts` preserves and discloses original malformed patches when it normalizes hunk counts.

```mermaid
flowchart LR
  A["Supplied task and context"] --> B["Classify"]
  B --> C["Check hard eligibility"]
  C --> D["Rank eligible destinations"]
  D --> E["Execute bounded task"]
  E --> F["Record artifact, identity, usage and outcome"]
  F --> G["Host reviews, applies and tests"]
```

### Hypothesis

Existing coding clients can use delegated artifacts under their own permissions. A bounded comparison tests different classifiers and accessible models under one policy.

### Learnings

All three clients actually delegated bug-fix, test-writing and repository-analysis tasks, then used the returned artifacts and passed independent tests.

| Client | Version | Independent tests in primary successful run |
|---|---|---|
| OpenCode | 1.18.31 | 10 tests, 55 assertions |
| Claude Code | 2.1.278 | 5 tests, 9 assertions |
| Codex | 0.154.0 | 6 tests, 9 assertions |

The evidence index contains 16 sessions: 12 condition passes and 4 preserved failures. Separate real-client sessions cover interruption, malformed responses, unsupported requests and unavailable routes. Failure-handling passes do not count as completed bug fixes. Delegate identity is configured-unverified and its cost is unknown.

The comparison freezes four calibration and four held-out synthetic tasks. All four classifiers selected GPT4.1 mini, which passed 2/4 held-out graders; fixed GPT4.1 passed 3/4. Routing results replay recorded destination answers. Flat calibration cannot identify a classifier's contribution, and unknown overhead prevents a savings claim.

> [!NOTE]
> Review `routing/` source/tests and `integration/` fixture runners first. Static protocols, transcripts, diffs and results account for much of `routing/comparison/` and `integration/evidence/`; start with their READMEs and evidence index. Historical observations are not relabeled as runs of the final source.

### Testing

Recorded local checks, before PR branch assembly:

- [x] `bun test jev-experiments/roadmap/routing`: 66 tests, 398 assertions. Covers hard limits, cancellation, malformed artifacts, callback identity/accounting, exact destination-model matching and MCP recovery.
- [x] `./jev-experiments/roadmap/node_modules/.bin/tsc --noEmit -p jev-experiments/roadmap/tsconfig.json`: passed in the integrated working tree.
- [x] `python3 jev-experiments/roadmap/routing/fresh_install.py`: fresh Bun installation passed diagnostics, three-tool MCP discovery, explicit email classification with unchanged input, and uninstall. The final registry produces an 84,933-byte bundle; its checksum is retained in `routing/fresh-install.json`.
- [x] `python3 jev-experiments/roadmap/routing/verify-isolated.py --base origin/main`: archived base `eb3c18d6db28` plus runtime patch and routing files passed 83 combined tests, 448 assertions, TypeScript and fresh installation. The only Mac dependency is `mac/models.json`.
- [x] Actual client outcomes above have retained MCP audits, host transcripts, applied diffs and independent test output in `integration/evidence/`.
- [x] The assembled branch passed a second isolated check at `afb7cbf129d8`: 83 tests, 448 assertions, TypeScript and fresh installation. The 84,933-byte bundle matches the final source checksum. Provider calls and GPU work were disabled. These are local branch checks; Vercel artifact previews do not apply the app patch.
