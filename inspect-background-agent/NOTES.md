# Notes: Inspect-style background agent

Source posts:
- https://builders.ramp.com/post/why-we-built-our-background-agent
- https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal
- Inspiration (not a fork): https://github.com/ColeMurray/background-agents

## UI log formatting (2026-08-03)

`#log` was a raw `textContent` dump: markdown fences stayed literal, and `turn.finished` repeated the whole agent summary. Switched to structured entries (system / turn markers / agent bubble / tool chips) with a tiny fenced-code + inline-`code` renderer. Finished turns no longer re-dump the summary.

## Figure-it-out run (2026-08-03)

Targeted usual harness failure modes without rewriting to CF/Modal.

Done:
- Verbatim experiment `AGENTS.md` (no backward compat; subtract obsolete paths)
- `SessionQueues` — serial prompts per session
- `ResourceLifecycle` — DELETE + idle TTL reaper, idempotent destroy
- `models.ts` + `GET /api/models` + `OPENCODE_MODEL`
- `npm run eval:smoke` — math-add + greet-txt against real OpenCode
- Removed fake product path: `scripts/demo.ts`, `adapters/local`, `workspace/`, `runner/`, `prompt-ingress`, `createSessionActor`
- Playbook + `decisions.tsv`

Verified green:
- `npm test` (6)
- `npm run e2e` (file + commit + DELETE diskGone)
- `npm run eval:smoke` (2/2)

## Critical learning (earlier)

OpenCode resolves the *git project root*, not just `cwd`. Sandboxes nested inside this hatch repo caused writes to land in `inspect-background-agent/src/`. Fix: sandboxes live under `/tmp/hatch-inspect` and every run passes `--dir`.

## Architecture retained

Three planes from the CTO diagram, local stand-ins:
- Control: Hono API + EventBus + SessionQueues + ResourceLifecycle
- Orchestration: GitSandboxManager
- Execution: OpenCodeBridge

Peer survey: `design/HARNESSES.md`. Arena history: `arena/`.

## Commands

```bash
cd inspect-background-agent
npm install
npm test
npm run e2e
npm run eval:smoke
npm run serve   # http://127.0.0.1:8787
```

Optional: `OPENCODE_MODEL=ling-3.0-flash-free` (still under provider `opencode`).
