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
| Triggers | Automatic runs from a no-model scan of finished sessions; the `learning` setting | Done ([ADR-0020](adrs/0020-learning-triggers.md)): `off` (the default) or `suggest`, idle and every-N-turns triggers, a daily cap. `gated` was deleted. Deferred: idle-time consolidation |
| Offer to learn | Item 4 of the simplification plan: the default way learning starts | Done (2026-09-28, ADR-0020 amended): `learning/signals` (no model, no cost) and `learning/dismiss`; the TUI asks `[y/N]` on quit, the desktop shows a notice when a turn ends or the window leaves a session; `learning.ask: false` silences it; `strive run` never asks |
| Subtraction | Remove the replay gate, `gated`, watches; the judge advises | Done (2026-09-28) |
| One list | What shapes a session (instructions, skills, memory, settings) is one list the loader reads from and the gate and the sandbox guard | Done (2026-09-28). `AGENTS.md`, `CLAUDE.md`, `.claude/skills` and `.strive/settings.json` now ask a person in every mode; links and imports off the list aren't loaded |
| Bullet proposals | Item 5 of the simplification plan, replacing "proposals in the shadow repository": a memory proposal changes one bullet | Done (2026-09-29, [ADR-0022](adrs/0022-bullet-proposals.md)): add, change or remove of one bullet, each bullet's source in a comment; accept and rollback per bullet, in any order, past hand edits elsewhere; `strive review --memory` and the Learned pane's "What every session reads now". Skills stay whole-file |
| Eval | Does learning help? A synthetic project, 11 families of tasks, arms with learning frozen, on, given the rules, poisoned and placebo ([ADR-0021](adrs/0021-eval.md)) | Done (2026-09-30, Haiku 4.5, 470 tasks, $37): all 8 pre-registered hypotheses pass. On learnable families F 10%, L 53%, oracle 90%, placebo 12%; no harm on generic tasks. The learner was the bottleneck: a family was learned only when it proposed the rule at the seed |
| Stated rules | The learner proposes a standing rule the user stated, from one session | Done (2026-09-30): `scripts/eval/learner_probe.py`, the learner alone on each seed's session, went from 4/24 to 19/24 runs proposing the rule, with no proposals on the controls. Poisoned rules are learned as readily; the reviewer is the check. Next: a full L-arm rerun |
| Checks | The first declarative extension: a command the daemon runs at the end of a turn that changed matching files, learned like a skill ([ADR-0023](adrs/0023-checks.md)) | Done (2026-09-30). Next: slash commands and path-scoped rules, the same way |
| Slash commands | A prompt saved as a file, run as `/name arguments`, in Claude Code's format; learned like a skill ([ADR-0024](adrs/0024-slash-commands.md)) | Done (2026-09-30). The daemon expands them, so every client runs them alike |
| Path rules | Guidance for the files a rule's paths match, given with the first such file in a session; Claude Code's format; learned like a skill ([ADR-0025](adrs/0025-path-rules.md)) | Done (2026-09-30). The extension plan's first milestone is complete |
| Bullet use | Sessions cite the bullets they act on; per bullet, sessions given, turns cited and trouble after, in review, the desktop and the learner ([ADR-0026](adrs/0026-bullet-use.md)) | Done (2026-10-01) |
| Code extensions | Tools in TypeScript a project declares, each call run as a sandboxed command, unasked only once a person accepts it ([ADR-0027](adrs/0027-code-extensions.md)) | Done (2026-10-01): running them, and proposing them from a work session (a whole-directory change, a tests gate, review), and safe mode (`strive --safe`, or `"extensions": false`) |
| Hooks | An accepted extension's code before each tool call, which may ask a person or refuse, never allow or rewrite ([ADR-0028](adrs/0028-hooks.md)) | Done (2026-10-01): `tool_call` only; checks already cover a turn's end |
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
