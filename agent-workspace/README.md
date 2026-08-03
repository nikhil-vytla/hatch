# Agent Workspace

A production-shaped web workspace for a local AI agent — chat, sessions, files, memory, skills, and terminal in one process. Studied [outsourc-e/hermes-workspace](https://github.com/outsourc-e/hermes-workspace) for the product shape and security model; built independently on the stack this hatch already trusts (Hono, better-sqlite3, OpenCode free models). Not a fork.

## Run it

```bash
cd agent-workspace
npm install
npm test        # security + store + backend contract (7)
npm run e2e     # auth → streamed real-model reply → restart persistence
npm run serve   # http://127.0.0.1:8899
```

No API keys needed: the default backend is the OpenCode CLI with free `opencode/*` models. Point `OPENAI_BASE_URL` (+ optional `OPENAI_API_KEY`, `WORKSPACE_MODEL`) at any OpenAI-compatible server (Ollama, LM Studio, vLLM, a gateway) to switch backends; `/api/health` reports which mode is live — the hermes portable-vs-enhanced pattern.

## What you get

| Pane | Backing |
| --- | --- |
| Chat | SSE streaming; transcript persisted in SQLite; survives restart (e2e-proven) |
| Sessions | Create / rename / delete; sidebar with message counts |
| Files | Browser + editor rooted at `WORKSPACE_FILES_ROOT`, real-path traversal guard |
| Memory | Shared markdown notes (`data/memory/*.md`), CRUD |
| Skills | Read-only browse of `.md` skill docs (`WORKSPACE_SKILLS_DIR`) |
| Terminal | Piped bash over WebSocket (documented: no PTY resize in v1) |

## Security (hermes rules, test-proven)

- **Fail-closed bind**: refuses to start on non-loopback without `WORKSPACE_PASSWORD`
- Auth middleware on every `/api/*` route when a password is set (cookie or bearer)
- Login rate limiting; constant-time password compare
- Path traversal blocked by **resolved real path** (covers `../`, absolute paths, and symlink escapes — see `tests/workspace.test.ts`)
- Session cookies `HttpOnly` + `SameSite=Strict`, `Secure` via `COOKIE_SECURE=1`

## Configuration

```env
HOST=127.0.0.1              # 0.0.0.0 requires WORKSPACE_PASSWORD
PORT=8899
WORKSPACE_PASSWORD=...      # enables auth
WORKSPACE_FILES_ROOT=...    # file browser root (default: cwd)
WORKSPACE_SKILLS_DIR=...    # skills dir (default: data/skills)
OPENAI_BASE_URL=...         # switch to an OpenAI-compatible backend
OPENAI_API_KEY=...
WORKSPACE_MODEL=...         # default: opencode/big-pickle
COOKIE_SECURE=1             # behind HTTPS
```

## Docker

```bash
echo 'WORKSPACE_PASSWORD=change-me' > .env
docker compose up --build   # http://127.0.0.1:8899
```

## Design trail

- Playbook + done predicate: [`PLAYBOOK.md`](PLAYBOOK.md)
- Decisions: [`decisions.tsv`](decisions.tsv)
- Working notes: [`NOTES.md`](NOTES.md)

## Not in v1 (deliberate)

PWA service worker, Electron shell, multi-agent swarm/conductor lanes, skill marketplace, PTY resize. Hermes-workspace built those over many releases; this layer stops at a product that is verified end-to-end.
