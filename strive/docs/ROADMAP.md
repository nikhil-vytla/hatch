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
| M8 Learner | Learning mode in `packages/host`: its prompt, `list_sessions`, `read_session`, `propose_change`; evidence within a token budget | In progress |
| M8b Desktop | The Learned pane | Planned |
| M9 Judge gate | A model the learner doesn't control scores proposals against held-out sessions | Planned |
| M10 Replay gate | Past tasks with checkable outcomes, run with and without a change | Planned |
| M11 Predictions and drift | Predictions checked against later sessions; a watch for decline; scoped rollback | Planned |

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
