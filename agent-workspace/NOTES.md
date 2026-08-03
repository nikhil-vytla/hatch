# Notes: agent workspace (hermes-workspace study)

Studied product: https://github.com/outsourc-e/hermes-workspace — web workspace over the Hermes Agent gateway (chat/sessions/memory/skills/files/terminal/dashboard, auth, PWA, Docker, capability probing). We built the same product shape for backends this hatch can run without credentials.

## What shipped (v1, all verified)

- One Hono process: REST + SSE chat + WS terminal + embedded single-page UI (`:8899`)
- `ChatBackend` port with two implementations:
  - `opencode-cli` (default, free models, no key) — transcript rendered into `opencode run`
  - `openai-compat` — streaming `POST /v1/chat/completions` (Ollama/LM Studio/vLLM/gateways)
  - `/api/health` reports the live mode (hermes portable-vs-enhanced pattern)
- SQLite persistence (`WorkspaceStore`) — sessions + messages survive restart (e2e-proven)
- Security following hermes rules, all test-proven:
  - fail-closed bind (no non-loopback without `WORKSPACE_PASSWORD`)
  - auth middleware on every `/api` route; cookie (`HttpOnly`/`SameSite=Strict`) or bearer
  - login rate limiter; constant-time compare
  - `safeResolve`: real-path traversal guard (`../`, absolute, symlink escape)
- Files browser/editor, memory notes CRUD, skills read-only browse, piped-bash terminal
- Dockerfile + compose (password enforced via compose var)

## Verification log

- `npm test` — 7/7 (bind guard, tokens, limiter, traversal incl. symlink, store restart, backend contract)
- `npm run e2e` — auth gate 401 → login → streamed `pong` from `opencode/big-pickle` → traversal 400s → **server restart, transcript intact**
- Live probes: memory PUT/list, files list, skills empty-state, UI HTML served, terminal WS `echo term-42` round-trip
- `npx tsc` build output loads from `dist/`
- `docker build`: **not verified** — Docker is not installed on this VM. Dockerfile steps (prod install, tsc compile, tsx serve) verified individually.

## Bug found by browser verification (fixed)

The visual check caught what the raw WS probe missed: `bash -i` inherits the server's controlling TTY (tmux) and its job-control attempt SIGTTOU-stops the **whole server process group** — the workspace froze mid-demo. Root cause fix, not a workaround: spawn non-interactive `bash --noprofile --norc` with `detached: true` (own process group, no TTY access), kill the group on socket close. Re-verified in the browser: `echo hello-ws` round-trips and `/api/health` stays live afterward. Lesson: a probe that only checks the happy frame passes while the process is dying — verify on the real surface.

## Decisions that mattered

- **No node-pty**: native build friction for marginal v1 value; piped bash documented as no-PTY. Encoded in UI copy.
- **Transcript-in-prompt for OpenCode**: `opencode run` is single-shot; we render the session history each turn. Good enough for chat; a future layer can use `opencode serve` sessions.
- **Embedded UI, no build step**: same pattern that worked in `inspect-background-agent`; production-readiness here is the server guarantees, not a bundler.
- **better-sqlite3 over an ORM**: already trusted in this hatch; schema is two tables.

## Relation to inspect-background-agent

Different product: inspect = background coding agent (sandboxes, branches, PRs). This = the workspace/command-center UI (conversation, memory, files, terminal). They share design language and the OpenCode backend but no code dependency.
