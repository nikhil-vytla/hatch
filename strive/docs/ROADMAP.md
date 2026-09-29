# Roadmap

## Stage 1: a usable agent

| Milestone | Scope | Status |
| --- | --- | --- |
| M0 Skeleton | Workspaces, daemon lifecycle, protocol + codegen, TUI handshake, `doctor`, install script, CI | Done |
| M1 Journal | Authenticated session journal, `strive log`, `strive verify`, `strive sessions`, continue and resume | Done. The content store moves to M2, where model wire bytes first need it |
| M2 Gateway + budgets | Content store; Anthropic/OpenAI through the daemon's gateway; reservation budgets; TUI spend footer and `/budget`; `strive auth` | Done. `/login` for subscriptions is deferred: API keys first, provider terms to check. Wall-time caps move to M3 with the agent loop |
| M3 Agent | pi-agent-core loop; read/write/edit/bash run by the daemon; approval modes; sandbox; checkpoints + `/rewind`; turn time limits | Done. A real Haiku run fixed a bug in a scratch repo for $0.0124 |
| M4 Context | AGENTS.md, SKILL.md, MCP, compaction, settings. Exit: daily use on this repo | Done. A real Haiku run on this repo answered from AGENTS.md, listed its skill and called an MCP tool after approval, for $0.0069 |
| M5 Desktop | Electron client on the workspace document; drag-and-drop; agent layout edits as proposals | Done. `strive app`; Playwright drives it against a real daemon. Signing and notarization are tracked, not blocking |
| M6 Headless | `strive run --headless --json`; Harbor Terminal-Bench smoke run | Done. `strive run`; `harbor/strive_agent.py`. Terminal-Bench 2.0 `fix-git` with Haiku 4.5: reward 1.0, 11 model calls, $0.036 |

## Stage 2: trusted learning

The design is [ADR-0016](adrs/0016-trusted-learning.md).

| Milestone | Scope | Status |
| --- | --- | --- |
| M7 Proposals | The learning session, `learning/open` and `learning/run`; `proposalMade` from its host only; the static gate; `proposal/list`, `decide` and `rollback`; stale detection; `.strive/memory.md` in the agent's context; `strive review` and `strive learn` | Done. The learner's host is also given its memory and skills whole (`learnedFiles`), and `before` is the file as it was shown. The judge and replay gates are journaled as skipped |
| M8 Learner | Learning mode in `packages/host`: its prompt, `list_sessions`, `read_session`, `propose_change`; evidence within a token budget | Done. A real Haiku run proposed "run `bun test src`"; accepted, the next session ran it first, as predicted ($0.06) |
| M8b Desktop | The Learned pane | Done. Diff, reasons, evidence (with the cited entries inline), checks (the judge by criterion), per-file history, files changed outside review, accept/reject/rollback |
| M9 Judge | A model the learner doesn't control scores proposals against held-out sessions | Done ([ADR-0017](adrs/0017-judge-gate.md)). ~$0.008 a proposal on Haiku. Amended: its verdict is advice beside the diff; a fail doesn't block |
| M10 Replay gate | Past tasks with checkable outcomes, run with and without a change | Built, then deleted ([ADR-0018](adrs/0018-replay-gate.md), superseded): at 3 runs a side a no-op change passed a third of the time |
| M11 Predictions and drift | Predictions checked against later sessions | Built, then deleted ([ADR-0019](adrs/0019-predictions-checked.md), superseded). Kept: the prose prediction, memory that may be stale |
| Triggers | Automatic runs from a no-model scan of finished sessions; the `learning` setting | Done ([ADR-0020](adrs/0020-learning-triggers.md)): `off` (the default) or `suggest`, idle and every-N-turns triggers, a daily cap. `gated` was deleted. Deferred: idle-time consolidation, an end-of-session prompt |
| Subtraction | Remove the replay gate, `gated`, watches; the judge advises | Done (2026-09-28). Next: an offline `strive eval` for system-level validation |
| Review | Adversarial reviews of the trust boundary, correctness and tests | Done. Trust: symlinks in replay setup, ties, citation steering, control characters, mode at proposal time. Correctness: crash recovery for learner turns and replay holds, idempotent accept/rollback, rejected proposals stop checking, lost trigger signs. Tests: surviving mutants killed, weak tests fixed |

## Later stages

3. **Reach:** a Harbor adapter and baseline, an ACP server for editors, and
   vendor engines.
4. **Deep self-improvement:** harness-code extensions as learnable artifacts,
   a variant archive and lineage-aware selection.

## Performance budgets

| Path | Budget | M0 measurement (macOS, release) |
| --- | --- | --- |
| Warm `strive` to first TUI frame | < 150 ms | 59 ms p50 |
| Cold daemon start + first request | < 300 ms | 16 ms p50 |
| Warm request round trip (`strive status`) | — | 3.1 ms p50 |
| Desktop: streaming reply text over ~1000 transcript lines | 120 fps | 120 fps; frame p50 8.3 ms, p95 10.3 ms (`apps/desktop/bench.ts`, M5) |
