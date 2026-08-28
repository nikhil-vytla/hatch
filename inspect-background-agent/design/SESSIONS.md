# Session list, fork, archive, delete

Compared to Ramp Inspect / [Open-Inspect](https://github.com/ColeMurray/background-agents).

## Multi-session visibility

| Capability | Ramp / Open-Inspect | Hatch now |
| --- | --- | --- |
| List sessions with status | Web home + Slack; DO-backed | `GET /api/sessions` + sidebar list (poll ~2.5s) |
| Status values | richer (`sandbox_spawning`, etc.) | `idle` \| `running` \| `error` (+ archived badge) |
| Switch thread without losing others | yes | click a row; WS reconnects to that session |
| Live multiplayer presence | yes | no |
| Org-wide dashboard / merged-PR stats | yes | no |

Many sessions can run at once (each has its own sandbox + queue). The UI shows all non-archived rows sorted by `lastActiveAt`.

## Forking

| Capability | Ramp / Open-Inspect | Hatch now |
| --- | --- | --- |
| Agent `spawn-child` tool | yes (parallel child sandboxes) | not an agent tool yet |
| User fork / branch explore | common product pattern | `POST /api/sessions/:id/fork` |
| What fork copies | snapshot / image restore | git clone of parent repo HEAD onto new `inspect/<id>` branch |
| Dirty tree | snapshot FS | default: auto-commit `"inspect: snapshot before fork"` then clone |
| Lineage | parent/child links | `parentSessionId` on the child |

Fork is **user-driven branching**, not Ramp's agent-spawned child research sessions. Child spawn can layer later as a tool that calls the same fork port.

## Archive vs delete

Open-Inspect lifecycle: `Created → Active ⇄ Archived` (restore keeps work via sandbox snapshot).

| Action | Hatch | Disk | Prompts |
| --- | --- | --- | --- |
| **Archive** `POST .../archive` | soft-hide from default list | kept | rejected until restore |
| **Restore** `POST .../restore` | clears `archivedAt` | kept | allowed again |
| **Delete** `DELETE ...` | hard remove session | destroyed | n/a |
| **TTL reap** | idle non-archived past TTL | destroyed | n/a |

Archived sessions are **skipped by the TTL reaper** so archive stays restorable for the life of the process (no Modal snapshot yet; restart of the Node process still loses the in-memory index unless we add durable store later).

## API

```
GET    /api/sessions?include=archived
POST   /api/sessions/:id/fork      { title?, prompt?, commitDirty? }
POST   /api/sessions/:id/archive
POST   /api/sessions/:id/restore
DELETE /api/sessions/:id
```

UI: Sessions list, Fork / Archive / Restore / Delete beside the prompt controls.

## Artifacts (code / diff / screenshots)

| Capability | Hatch now |
| --- | --- |
| Changed file contents | Files tab via `GET /api/sessions/:id/artifacts` |
| Unified diff | Diff tab (working tree vs HEAD, or last commit if clean) |
| Screenshots / VNC | Tab present; empty. Needs Modal sidecars (see CLOUD.md) |
