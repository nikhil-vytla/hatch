# Hatch Inspect

A working local background coding agent inspired by Ramp's Inspect and informed by
[ColeMurray/background-agents](https://github.com/ColeMurray/background-agents) — not a fork.

Experiment steering lives in [`AGENTS.md`](AGENTS.md). Hardening playbook: [`PLAYBOOK.md`](PLAYBOOK.md).

## It works

```bash
cd inspect-background-agent
npm install
npm test          # queues, lifecycle, models, pure policy
npm run e2e       # sandbox + OpenCode + commit + DELETE disk
npm run eval:smoke
npm run serve     # http://127.0.0.1:8787 web UI + API
```

`npm run e2e` boots a control plane, seeds a git sandbox under `/tmp/hatch-inspect`, runs
`opencode run --dir <sandbox> --model opencode/big-pickle`, verifies `src/math.ts`, commits,
then `DELETE`s the session and checks the sandbox directory is gone.

## What you get

| Layer | Implementation |
| --- | --- |
| Control plane | Hono REST + WebSocket event stream + embedded web UI |
| Async | Per-session promise queue (`SessionQueues`) — no overlapping OpenCode in one sandbox |
| Lifecycle | `DELETE` destroys disk; idle TTL reaper; destroy is idempotent |
| Sandbox | Real git repo per session, branch `inspect/<id>` under `/tmp` |
| Agent | OpenCode CLI with free `opencode/*` models (default `big-pickle`) |
| Models | `GET /api/models` + `OPENCODE_MODEL` |
| Authorship | Commits use the prompting author's name/email |

## API

- `POST /api/sessions` `{ prompt, title?, cloneUrl?, authorName?, authorEmail? }`
- `GET /api/sessions` list (+ `?include=archived`)
- `POST /api/sessions/:id/prompt` `{ text }` (queued)
- `POST /api/sessions/:id/fork` `{ title?, prompt? }` new sandbox from HEAD
- `POST /api/sessions/:id/archive` / `.../restore`
- `POST /api/sessions/:id/commit` `{ message? }`
- `DELETE /api/sessions/:id` destroy sandbox
- `GET /api/sessions/:id` status + diff
- `GET /api/models` known-free models
- `WS /api/sessions/:id/events` realtime envelopes

## Harness problems this layer hits

| Problem | Local answer |
| --- | --- |
| Good async | Serial per-session queue |
| Resource lifecycle | Explicit destroy + TTL reap |
| Evals | `npm run eval:smoke` (≥2 tasks) |
| Extensions | OpenCode itself (no custom plugin registry yet) |
| Types | Branded kernel + server-local `SessionRow` |
| Model compat | Thin free-model list + env override |

## Design notes

- **Deviations vs Ramp / Open-Inspect:** [`design/DEVIATIONS.md`](design/DEVIATIONS.md)
- **Sessions / fork / archive:** [`design/SESSIONS.md`](design/SESSIONS.md)
- **CF + Modal plan:** [`design/CLOUD.md`](design/CLOUD.md)
- Topology / CTO diagram: [`design/TOPOLOGY.md`](design/TOPOLOGY.md)
- Peer harness survey: [`design/HARNESSES.md`](design/HARNESSES.md)
- Arena history: [`arena/`](arena/)
- Decision trail: [`decisions.tsv`](decisions.tsv)

Sandboxes must sit **outside** this git checkout. OpenCode resolves the enclosing project root;
we force `--dir` and store sandboxes in `/tmp/hatch-inspect`.

## Not included yet (planned in CLOUD.md)

Cloudflare Durable Objects, Modal snapshots/Queue, Slack/GitHub bots, VNC/code-server.
Local stays green while those land as adapters behind the same plane split.
