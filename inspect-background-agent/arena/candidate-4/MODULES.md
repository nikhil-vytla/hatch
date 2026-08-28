# Module map

Grouped by the decision each module owns. The test applied to every boundary below: *if this
decision changed, how many directories would I have to edit?* If the answer is more than one,
the boundary is in the wrong place.

```
src/
  kernel/          brands, Result, Clock-facing time types
  identity/        actors, credentials, conversation refs
  workspace/       ← root aggregate: supply of compute for one repo
  slot/            one sandbox and its write gate
  session/         one conversation and its lease
  authorship/      who gets credit, whose token is used
  agent/           the runtime port and what a turn may reach back into
  clients/         surface translation (slack, web, extension)
  ports/           interfaces only, no logic
  adapters/        local, modal, cloudflare, github, opencode, classifier
  testing/         fake clock, scripted agent, git fixture
  index.ts         the public surface
```

Import direction is one-way: `clients → index → {workspace, session} → {slot, authorship,
agent} → {identity, ports, kernel}`. `adapters/` may import `ports/` and `kernel/` and nothing
else. Pure policy functions import `kernel/` only. There is no path from `slot/` back up to
`session/`, which is what keeps the gate from needing to know what a turn is.

---

## `kernel/`

Owns the brand construction, `Result`, and the id vocabulary. No behaviour.

It exists so that `CommitSha`, `UserToken` and `InstallationToken` are not all `string`. The
credential brands are the load-bearing ones: `ForgePort.openPullRequest` takes a `UserToken`
and `MutableSlot.push` takes an `InstallationToken`, so "the human opens the PR, the App does
the clone" is a compile error to violate rather than a code-review convention.

## `identity/`

Owns: what an actor is, how a surface id (Slack user, GitHub login, session cookie) resolves to
one, and how a token is fetched at the moment of use.

Does not own: authorisation. There is no per-session owner to check against — a session has a
roster, and any participant may act.

The rule this module enforces by shape: **callers pass `Actor`, never tokens.** `publish` takes
an `Actor`; `authorship/` exchanges it for a `UserToken` inside. A token never appears in an
argument list any application code writes.

## `workspace/`  — the root aggregate

Owns everything repo-scoped and expensive:

| Decision | Where |
| --- | --- |
| when to rebuild the image, what the recipe is | `generations.ts` |
| how many slots stay warm, when a keystroke justifies a boot | `pool.ts` (`planPool`) |
| warm-pool hit vs. cold boot vs. snapshot resume | `leases.ts` (`planAcquisition`) |
| lease TTL, fencing epochs, heartbeat | `leases.ts` |
| reclaiming slots from crashed sessions, parking idle ones | `reaper.ts` |
| the branch namespace, and therefore webhook→session routing | `routing.ts` |
| merged-PR rate, humans prompting in the last 5m | `stats.ts` |

Why these are one module and not seven: they are all answers to *"what compute exists for this
repo right now and how stale is it"*, and they all read the same record. Pool sizing depends on
generation; acquisition depends on pool; reclamation depends on lease TTL; the branch prefix
comes from the same policy object. Splitting them would put one record's invariants behind
several boundaries.

Why this is not a temporal decomposition: build, boot, lease, reclaim run at different times,
but they protect one decision — the supply of slots. A change to the rebuild cadence changes
what the pool contains, what acquisition should prefer, and when reclamation fires. One edit,
one module.

Public surface: `Workspace` (six methods). Everything in the table above is private.

## `slot/`

Owns one slot's capability surface and the freshness gate: `Freshness` and its transitions,
`admitWrites`, the read-only vs. mutating split, the tool-effect classification table, and the
git operations that run inside a sandbox (fetch, reset, commit with a rewritten identity, push).

Split from `workspace/` because the knowledge is different in kind. `workspace/` reasons about
a *population* of slots and never about a file. `slot/` reasons about one filesystem and never
about the pool. The seam is `LeasedSlot`: the workspace mints it, the slot module defines what
it can do.

The invariant this module encodes structurally: **write methods do not exist on a stale slot.**
`LeasedSlot` has `read`/`list`/`run(ReadOnlyCommand)`. `MutableSlot` has `write`/`commit`/
`push`, and the only constructor for one is `await slot.admitWrites()`. There is no
`if (!synced) throw` anywhere, and no caller can forget the check because there is no check.

`tool-effects.ts` is the single source of truth for "does this tool call mutate". Both the
OpenCode plugin and the scripted fake consult it. A second copy of that table in the adapter
would be the leakage this module exists to prevent.

Not exported from `index.ts`. Application code never holds a slot.

## `session/`

Owns the conversation: the append-only turn queue (`queue.ts`, `advanceQueue`), stop and
cancel, per-actor participant records and their read-boundary merge (`participants.ts`,
`mergeParticipants`), the event log and its sequence numbers (`transcript.ts`), and child
session bookkeeping (`children.ts`).

Does not own: compute, git, freshness, snapshots, tokens. It holds a `SlotLease` and asks the
workspace to renew or re-acquire it. When a parked session is prompted, `session/` calls
`workspace.start`-equivalent re-acquisition and does not know whether it got a pool slot or a
snapshot restore.

Shared-write question, answered explicitly:

- **Turn queue** — serialised through the session actor. Two clients submitting at once get a
  deterministic order, because order is the thing users perceive. Single writer, on purpose.
- **Participant presence, drafts, cursors, last-seen** — per `(actor, surface)` record, never
  merged on write, merged on read by `mergeParticipants`. Two clients belonging to the same
  human cannot clobber each other, per separate-before-serializing-shared-state.
- **Warm hints** — not session state at all. They go to the workspace and merge by union.

## `authorship/`

Owns who gets credit and whose credential is used: contributor derivation from the turn ledger
(`contributorsOf`), the git identity rewrite on commit, PR body rendering, and the idempotent
open-or-update against the forge.

This is the module most likely to be mistaken for a pipeline stage called "publish". It is not:
it owns a *policy* — attribution — that is consulted at three different times (on commit, at PR
open, and when a `pr.merged` webhook lands and stats need to know whose PR merged). Naming it
after the moment it runs would hide that.

Single source of truth: contributors are **derived** from turns whose outcome carries commits.
There is no contributor list maintained alongside the queue, so the two cannot disagree.

## `agent/`

Owns the `AgentRuntime` port, the `TurnCapabilities` bundle, and the domain `AgentDelta` union.

`TurnCapabilities` is the whole reachback surface: the gate, the status callback, the child
spawner, and an `extraTools` array. An agent running in a slot has no other route back into the
system — no session handle, no workspace handle. Ramp's internal MCP set, computer use, and the
screenshot-to-PR tools all arrive as `extraTools` without either `session/` or `workspace/`
changing.

`adapters/opencode/` owns the OpenCode server lifecycle, the typed SDK client, and three plugin
registrations built from the capability bundle. No OpenCode type crosses into `agent/`.

## `clients/`

Owns surface translation only: Slack Block Kit rendering and event normalisation, the web app's
SSE framing and cold-render payload, the extension's DOM-selection attachment shape.

Each client imports `index.ts` and nothing deeper. The test that keeps them honest: a client
must be writable by someone who has never read `workspace/` or `slot/`. Call site 1 in
[USAGE.md](USAGE.md) is the proof obligation — it is the entire Slack integration and it
mentions no sandbox, no sync, no lease.

`clients/extension/` is a stub with the attachment types filled in and no distribution story;
MDM and the update server are out of scope by the brief.

## `ports/` and `adapters/`

`ports/` holds interfaces and no logic: `ComputePort`, `ImagePort`, `StorePort`, `BusPort`,
`ForgePort`, `IdentityPort`, `RepoClassifierPort`, `Clock`, `IdPort`, plus `AgentRuntime` which
lives in `agent/` because its capability bundle is domain, not infrastructure.

Adapter pairs, so the whole system runs credential-free:

| Port | Deployed | Local |
| --- | --- | --- |
| `ComputePort` | Modal sandbox + snapshot API | directory + child process; snapshot = tarball |
| `ImagePort` | Modal image build | `git clone` + install script into a template dir |
| `StorePort` | two Durable Object classes (workspace, session) | SQLite, two tables |
| `BusPort` | DO WebSocket hibernation | `EventTarget` + an in-memory ring |
| `ForgePort` | GitHub App + OAuth | local bare repo + in-memory PR list |
| `AgentRuntime` | OpenCode server in the slot | `scriptedAgent` |
| `RepoClassifierPort` | small fast model | keyword + channel-name match |
| `Clock` | `Date.now` + DO alarms | `fakeClock` with drainable timers |

`StorePort` having exactly two aggregate keyspaces is the workspace-first stance showing up in
storage: one durable record per repo, one per session, and one small global directory for the
two lookups that genuinely cannot be derived (repo → workspace, conversation → session).

## Trace check

The runner discipline asks that following a flow take no more than three files.

- **prompt → agent output**: `session/session.ts` (queue, lease ensure) → `agent/runtime.ts`
  (attach, capabilities) → `adapters/opencode/` (plugins, frames). Three.
- **keystroke → warm slot**: `workspace/workspace.ts#hint` → `workspace/pool.ts#planPool` →
  `ports/compute.ts#boot`. Three, and the middle one is pure.
- **agent edit → allowed**: `adapters/opencode/plugins.ts` → `agent/capabilities.ts#gate` →
  `slot/gate.ts#admitWrites`. Three.
- **PR merged webhook → Slack card**: `index.ts#webhooks` → `workspace/routing.ts` (branch name
  → session id, no index) → `session/transcript.ts` (append event, clients are already
  subscribed). Three.
