# Self-check against `design-red-flags.md`

Screened the workspace-first sketch against all four flags. Two findings I fixed in the sketch,
four I am accepting with a reason, one I think is a genuine unresolved weakness.

## Shallow modules

**Clean where it matters.** `Workspace` is six methods and hides image cadence, pool sizing,
warm-on-keystroke, the warm/cold/resume decision, lease fencing, snapshots, idle parking, crash
reclamation, branch minting and webhook routing. `Session` is seven methods and hides queue
serialisation, roster merge, event sequencing and replay, transparent slot re-acquisition, and
the commit → push → open-PR → attribute sequence. `Session.publish` in particular replaces four
calls a caller would otherwise make in order, which is the specific "callers coordinate several
methods" sign.

**Finding — `IdPort` and `DirectoryStore` are shallow.** `IdPort` is five methods that each
return a uuid; `DirectoryStore` is a map with two keyspaces. Neither hides policy. I am keeping
both: `IdPort` exists so tests get deterministic ids without monkey-patching, and
`DirectoryStore` is deliberately the *only* global index in the system — its shallowness is the
point, and its size is the budget I am holding myself to. If a third keyspace shows up, that is
the signal that something derivable is being stored.

**Finding — `clients/` modules are thin by construction.** A Slack renderer that translates
`SessionEvent` into Block Kit hides nothing. That is correct at an edge: the alternative is
pushing rendering inward, which would put Block Kit types in the domain. Noting it so a reader
does not mistake it for an oversight.

**Accepted risk — two methods on the public surface that are not pulling their weight.**
`Session.park` is an optimisation the caller should never need, since the workspace parks idle
sessions on its own; it exists only because "I'm done" is cheaper than waiting out the timer.
`Workspace.rebuildImage` is an ops/test seam. Both are the first things I would delete if the
public surface needs to shrink.

## Information leakage

**Fixed during the screen.** `SessionLifecycle` originally carried `SlotLease` on `active` and
`SnapshotRef` on `parked`, which meant `session.view()` shipped slot ids, snapshot ids and lease
epochs to every web client — internal handles crossing the public boundary for no reason. Split
into a private `LeaseBinding` (what the session record stores) and a public `SessionLifecycle`
(`{ since, warmStart }` / `{ since, resumable }`), with `publicLifecycle` as the only projection.

**Clean by construction.** No Modal, Durable Object, OpenCode or GitHub type appears anywhere in
`SKETCH.ts`. GitHub payloads are parsed into `ForgeEvent` at `verifyWebhook`; OpenCode frames are
translated into `AgentDelta` inside `openCodeRuntime`; `StorePort` returns domain records, not
rows. `WorkspaceRecord` and `SessionRecord` are storage shapes and are never returned from a
public method.

**Finding — the tool-effect table would have leaked, and is now singular.** "Does this tool call
mutate the filesystem" was on its way to existing twice: once in the OpenCode plugin, once in the
scripted fake. It is now `ToolEffectPolicy` in `slot/`, and both consult it. Worth watching,
because the pressure to inline "well, `edit` obviously writes" into an adapter is constant.

**Accepted — `Freshness` is published widely.** It appears on `SlotEvent`, `SessionEvent`,
`SessionView` and `AgentDelta.tool.parked`. Adding a state means touching four renderers. I am
accepting this: freshness is domain vocabulary that users are meant to see ("waiting for the repo
to catch up"), not an internal representation, and hiding it would mean clients could not explain
why a turn is parked.

**Accepted — `WorkspacePolicy` is read by pure functions in several modules.** `planAcquisition`,
`planPool`, `advanceQueue` and `branchOfSession` all take it. It is one immutable value threaded
explicitly rather than a decision copied, so a change to it is one edit; but it is a wide type and
a future split into `PoolPolicy` / `LeasePolicy` / `BranchPolicy` would narrow the blast radius.

## Temporal decomposition

**Caught and renamed.** The authorship module was going to be called `publish/`, named after the
moment it runs. Its actual knowledge — who gets credit, whose credential is used — is consulted at
three separate times: on commit (git identity rewrite), at PR open (opener's token, contributor
list), and on the `pr.merged` webhook (whose PR merged, for stats). Naming it after one of those
would have hidden the other two.

**Standing risk — `workspace/` internals read as a pipeline.** `generations.ts → pool.ts →
leases.ts → reaper.ts` can be misread as build → boot → lease → reclaim. My defence is that they
all read and write one record and protect one decision (the supply of slots for a repo), and the
proof is that a change to the rebuild cadence changes all four. The test I would apply later: if a
change ever touches exactly one of these files and nothing else, the grouping was wrong.

**Note on §8 of the sketch.** The pure policy functions are collected in one section for
readability, not as a "logic layer". In the real tree each lives with its owner — `planPool` in
`workspace/pool.ts`, `advanceQueue` in `session/queue.ts`, `nextFreshness` in `slot/freshness.ts`.
A `policy/` directory would be exactly the temporal/layer split this flag warns about.

## Pass-through methods

**Checked each forwarding boundary.**

- `inspect.workspace(repo)` → not a pass-through: open-or-create, policy binding, image loop
  start, webhook registration.
- `inspect.dispatch(msg)` → the deepest method in the system; four subsystems behind one call.
- `inspect.locate(loc)` → adds three-way resolution, including the derive-don't-index branch
  lookup.
- `inspect.webhooks.deliver` vs. `Workspace.deliver` → same verb, different argument types
  (`RawWebhook` vs. `ForgeEvent`) and the boundary between them is signature verification,
  parsing and routing. Adaptation, not forwarding. The name collision is a smell I am accepting
  because renaming either one makes it read worse.
- `Session.cancel(turn, by)` → thin over the queue, but adds authorship and the status
  transition. Borderline; kept because removing it makes callers reach for `stop({scope:"queue"})`
  and lose a turn they wanted.

**Finding — `inspect.stats()` is close to a pure fan-out.** It maps over open workspaces and
returns their `WorkspaceStats` with no cross-workspace policy. It is honestly a pass-through with
a `Promise.all` in it. Keeping it because the dashboard needs one call and the alternative is the
client enumerating workspaces, but it is the weakest method on the root.

## The one I have not resolved

The cross-aggregate lease is the part of this design I trust least, and it is a direct
consequence of the workspace-first stance. Workspace and Session are separate Durable Objects, so
acquiring a lease is a network hop with partial-failure modes: the workspace can mark a slot
leased and the session can die before recording it. Fencing epochs plus lease TTL plus the reaper
make that eventually consistent rather than correct-by-construction — the slot is reclaimed, not
never-leaked. Session-rooted designs do not have this problem, and they pay for it elsewhere (no
owner for the pool, orphaned VMs), which is why I still prefer this shape. But it is the thing a
reviewer should push on first, and it is written up as the leading open question in
[RATIONALE.md](RATIONALE.md).
