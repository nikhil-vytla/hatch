# Figure-it-out: production-ready agent workspace

Studied product: [outsourc-e/hermes-workspace](https://github.com/outsourc-e/hermes-workspace) — a native web workspace for Hermes Agent (chat, sessions, memory, skills, files, terminal, dashboard, auth, PWA, Docker). We build the same product shape for the agent stack we actually have (OpenCode free models or any OpenAI-compatible backend), not a clone of their code.

## Phase A — Frame

### Done predicate (falsifiable, no API keys)

1. `npm test` green — auth, path-traversal guard, session store, chat backend contract
2. `npm run e2e` green — boots server, authenticates, creates a session, streams a real model reply (OpenCode free model), messages persist in SQLite, **server restart keeps the session and transcript**
3. `npm run serve` — one UI with: sessions sidebar, streaming chat, file browser + editor (workspace-rooted), memory notes (markdown CRUD), skills list, terminal
4. Security, test-proven:
   - every `/api/*` route rejects unauthenticated requests when a password is set
   - server **fails closed**: refuses to bind non-loopback without `WORKSPACE_PASSWORD` (hermes rule)
   - path traversal (`../`, absolute, symlink escape) on files/memory returns 400, checked against the resolved real path
5. Capability probe: `/api/health` reports which backend mode is live (`opencode-cli` or `openai-compat`) and the UI adapts (hermes portable-vs-enhanced pattern)
6. `docker build` succeeds from the included Dockerfile; compose file pairs workspace + env
7. Repo artifacts: README, NOTES, PLAYBOOK, decisions.tsv, _summary.md, verbatim AGENTS.md

### Scope

One Node 22 package (Hono + better-sqlite3 + ws + opencode-ai — the deps this hatch already trusts). Single-process server with an embedded single-page UI (no build step; same pattern that shipped in `inspect-background-agent`). Terminal is a piped `bash` over WebSocket (documented: no PTY resize; node-pty native build not worth it for v1).

### Rigor

**High**: security middleware + traversal guard + fail-closed bind (this is the "production-ready" claim), persistence across restart, real-model e2e.
**Medium**: UI polish, terminal fidelity.
**Skipped**: PWA service worker, Electron, Swarm/Conductor multi-agent lanes (hermes's own roadmap items), marketplace.

### Principles applied

- **model-the-domain**: `ChatBackend` port with two implementations; SQLite schema owns sessions/messages
- **boundary-discipline / type-system-discipline**: parse env + request bodies at the edge; branded workspace paths after the guard
- **prove-it-works**: e2e restarts the server and re-reads the transcript
- **subtract-before-you-add**: no plugin system, no theme engine; one clean theme
- **make-operations-idempotent**: login, session create, memory save are safe to retry

## Phase B — Units (riskiest first)

| # | Unit | Hypothesis | Verify |
| --- | --- | --- | --- |
| U1 | ChatBackend port + OpenCode CLI adapter | multi-turn transcript through `opencode run` streams usable replies | unit (fake) + live probe |
| U2 | SQLite store + chat SSE route | messages persist; restart keeps transcript | e2e |
| U3 | Auth + fail-closed + rate limit | unauthenticated 401 everywhere; 0.0.0.0 without password refuses to start | tests |
| U4 | Files + memory APIs with real-path guard | `../` and symlink escapes blocked | tests |
| U5 | Terminal over WS | shell echo round-trips | e2e-lite |
| U6 | Embedded UI (sessions/chat/files/memory/skills/terminal) | one page drives all APIs | manual + health |
| U7 | Docker + docs + trail | image builds | `docker build` |

## Phase C/D/E

Each unit lands green before the next. Decisions logged to `decisions.tsv` as they happen. Final check runs the whole predicate on the real product.
