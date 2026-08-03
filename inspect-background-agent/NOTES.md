# Notes: Inspect-style background agent

Source posts:
- https://builders.ramp.com/post/why-we-built-our-background-agent
- https://modal.com/blog/how-ramp-built-a-full-context-background-coding-agent-on-modal
- Inspiration (not a fork): https://github.com/ColeMurray/background-agents

## What works now (full local stack)

Control plane on Hono + WebSocket UI at `npm run serve` (port 8787).

Real path:
1. Create session → independent git sandbox under `/tmp/hatch-inspect/sandboxes`
2. Run OpenCode via `opencode run --dir <sandbox> --model opencode/big-pickle`
3. Stream tool/text events to the web UI / EventBus
4. Commit on the session branch as the prompting author

Verified: `npm run e2e` creates `src/math.ts` with `add`, commits SHA, exits 0.
Unit tests still cover domain types/fakes: `npm test`.

## Critical learning

OpenCode resolves the *git project root*, not just `cwd`. Sandboxes nested inside this hatch repo caused writes to land in `inspect-background-agent/src/`. Fix: sandboxes live under `/tmp/hatch-inspect` and every run passes `--dir`.

## Architecture retained

Three planes from the CTO diagram, local stand-ins:
- Control: Hono API + in-memory EventBus + session map
- Orchestration: GitSandboxManager (clone/seed, branch, commit)
- Execution: OpenCodeBridge (`opencode run`)

Peer survey remains in `design/HARNESSES.md`. Arena synthesis history in `arena/`.

## Commands

```bash
cd inspect-background-agent
npm install
npm test
npm run e2e
npm run serve   # http://127.0.0.1:8787
```

Optional: `OPENCODE_MODEL=ling-3.0-flash-free` (still under provider `opencode`).
