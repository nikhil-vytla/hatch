# Roadmap

## Stage 1: a usable agent

| Milestone | Scope | Status |
| --- | --- | --- |
| M0 Skeleton | Workspaces, daemon lifecycle, protocol + codegen, TUI handshake, `doctor`, install script, CI | Done |
| M1 Journal | Hash-chained session log + CAS, `strive log`, `strive verify`, resume | Next |
| M2 Gateway + budgets | Anthropic/OpenAI through the daemon, reservation budgets, status line, `/budget`, `/login` | |
| M3 Agent | pi-agent-core loop; read/write/edit/bash run by the daemon; approval modes; sandbox; checkpoints + `/rewind` | |
| M4 Context | AGENTS.md, SKILL.md, MCP, compaction, settings. Exit: daily use on this repo | |
| M5 Desktop | Electron client on the workspace document; drag-and-drop; agent layout edits as proposals | |
| M6 Headless | `strive run --headless --json`; Harbor Terminal-Bench smoke run | |

## Later stages

2. **Trusted learning:** proposals with predictions, a gate cascade,
   `strive review`, background consolidation and drift monitors.
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
