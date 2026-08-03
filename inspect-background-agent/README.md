# Hatch Inspect

A working local background coding agent inspired by Ramp's Inspect and informed by
[ColeMurray/background-agents](https://github.com/ColeMurray/background-agents) — not a fork.

Experiment steering lives in [`AGENTS.md`](AGENTS.md). Hardening playbook: [`PLAYBOOK.md`](PLAYBOOK.md).

## It works

```bash
cd inspect-background-agent
npm install
npm test
npm run e2e
npm run eval:smoke
npm run serve          # local monolith :8787
```

### Cloudflare + Modal (three planes)

```bash
npm run compute:shim                                    # compute :8790
COMPUTE_URL=http://127.0.0.1:8790 npm run serve:cloud   # control+UI :8788
npm run e2e:cloud                                       # proves the split

# Real Modal:  modal deploy cloud/modal/inspect_modal/app.py
# Real CF:     cd cloud/cloudflare && npm i && npm run dev
```

See [`design/CLOUD.md`](design/CLOUD.md).

`npm run e2e` boots a control plane, seeds a git sandbox under `/tmp/hatch-inspect`, runs
`opencode run --dir <sandbox> --model opencode/big-pickle`, verifies `src/math.ts`, commits,
then `DELETE`s the session and checks the sandbox directory is gone.

## What you get

| Layer | Implementation |
| --- | --- |
| Control plane | Hono REST + WebSocket event stream + embedded web UI |
| Frontend | Workspace-grade UI: session sidebar, streaming log, Files/Diff/**Terminal** tabs, login overlay |
| Auth | `INSPECT_PASSWORD` → cookie/bearer auth on all `/api` routes; fail-closed non-loopback bind; rate-limited login |
| Terminal | Per-session WS shell in that session's sandbox (`/api/sessions/:id/terminal`) |
| Async | Per-session promise queue (`SessionQueues`) — no overlapping OpenCode in one sandbox |
| Lifecycle | `DELETE` destroys disk; idle TTL reaper; destroy is idempotent |
| Sandbox | Real git repo per session, branch `inspect/<id>` under `/tmp` |
| Agent | OpenCode CLI with free `opencode/*` models (default `big-pickle`) |
| Models | `GET /api/models` + `OPENCODE_MODEL` |
| Authorship | Commits attribute to the prompting author (multiplayer: per-prompt identity) |

## API

- `POST /api/login` / `POST /api/logout` (when `INSPECT_PASSWORD` set)
- `POST /api/sessions` `{ prompt, title?, cloneUrl?, authorName?, authorEmail? }`
- `GET /api/sessions` list (+ `?include=archived`)
- `POST /api/sessions/:id/prompt` `{ text, authorName?, authorEmail? }` (queued, multiplayer)
- `POST /api/sessions/:id/fork` `{ title?, prompt? }` new sandbox from HEAD
- `POST /api/sessions/:id/archive` / `.../restore`
- `POST /api/sessions/:id/commit` `{ message? }`
- `POST /api/sessions/:id/pr` push branch; open GitHub PR as the user when a token exists
- `POST /api/hooks` external triggers (Slack workflows, Sentry, CI) with `X-Hook-Token`
- `GET/POST/DELETE /api/automations` recurring prompts
- `DELETE /api/sessions/:id` destroy sandbox
- `GET /api/sessions/:id` status + diff
- `GET /api/models` known-free models
- `WS /api/sessions/:id/events` realtime envelopes
- `WS /api/sessions/:id/terminal` shell in the session sandbox

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

## Not included yet (see CLOUD.md)

Image cron / snapshot restore, VNC sidecars, CF-hosted full web UI, SCM PR authorship.
Local monolith and three-plane paths both work. Deploy Modal + Wrangler when you have credentials.
