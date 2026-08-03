# Hatch Inspect

A working local background coding agent inspired by Ramp's Inspect and informed by
[ColeMurray/background-agents](https://github.com/ColeMurray/background-agents) — not a fork.

## It works

```bash
cd inspect-background-agent
npm install
npm test          # domain/unit (9)
npm run e2e       # real git sandbox + OpenCode free model → file + commit
npm run serve     # http://127.0.0.1:8787 web UI + API
```

`npm run e2e` boots a control plane, seeds a git sandbox under `/tmp/hatch-inspect`, runs
`opencode run --dir <sandbox> --model opencode/big-pickle`, verifies `src/math.ts`, and commits.

## What you get

| Layer | Implementation |
| --- | --- |
| Control plane | Hono REST + WebSocket event stream + embedded web UI |
| Sandbox | Real git repo per session (seeded or cloned), branch `inspect/<id>` |
| Agent | OpenCode CLI with free `opencode/*` models (default `big-pickle`) |
| Authorship | Commits use the prompting author's name/email |

## API

- `POST /api/sessions` `{ prompt, title?, cloneUrl?, authorName?, authorEmail? }`
- `POST /api/sessions/:id/prompt` `{ text }`
- `POST /api/sessions/:id/commit` `{ message? }`
- `GET /api/sessions/:id` status + diff
- `WS /api/sessions/:id/events` realtime envelopes

## Design notes

- Topology / CTO diagram: [`design/TOPOLOGY.md`](design/TOPOLOGY.md)
- Peer harness survey: [`design/HARNESSES.md`](design/HARNESSES.md)
- Arena history: [`arena/`](arena/)

Sandboxes must sit **outside** this git checkout. OpenCode resolves the enclosing project root;
we force `--dir` and store sandboxes in `/tmp/hatch-inspect`.

## Not included (on purpose for hatch)

Cloudflare Durable Objects, Modal snapshots, Slack/GitHub bots, VNC. Those are adapter swaps on
the same three-plane shape — see ColeMurray's Open-Inspect if you want the full cloud deploy.
