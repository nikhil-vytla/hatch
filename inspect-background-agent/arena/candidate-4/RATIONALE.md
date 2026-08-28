# Rationale — candidate 4

## Problem

We are building a hatch-scale replica of Ramp's Inspect: a background coding agent that runs in
a sandboxed VM, is driven from Slack and the web at the same time by several people at once,
and ends in a pull request authored by a human rather than by an app. The spec is the published
post, so the constraints are given rather than discovered: images rebuilt on a ~30 minute
cadence with sessions booting from snapshots and syncing at most that much git delta; reads
allowed before the sync lands but writes blocked until it does; an append-only prompt queue
with a stop, never mid-run insertion; one SQLite database per session in a Durable Object; a
GitHub App installation token for the clone and the user's own OAuth token for the PR; child
sessions spawned by the agent itself. It must also run on a laptop with no Modal, Cloudflare,
Slack or GitHub credentials, which forces ports and adapters rather than a direct-to-SDK build.

What makes the shape non-obvious is that the obvious noun is the wrong root. The product is
sessions — that is what users see, what Slack threads map to, what the Durable Object docs
nudge you toward. But almost nothing expensive or invariant-bearing in this system is
session-scoped. The image lineage, the warm pool, the staleness horizon, the branch namespace,
the installation token, the webhook feed and the reclamation of leaked sandboxes are all
per-repo, long-lived, and shared across sessions that never meet each other. A session-rooted
design has to invent a second home for all of it and then keep the two in agreement.

## Usage (caller's view)

Written first; the full text is [USAGE.md](USAGE.md), which the type sketch was derived from.
The shape of it:

```ts
const inspect = createInspect({ ports: await localPorts({ root: "./.inspect" }) });

const ws      = await inspect.workspace({ owner: "ramp", name: "ramp" });
ws.hint({ kind: "composing", actor });              // warm on keystroke, fire-and-forget
const session = await ws.start({ opener: actor, intent: "fix the flaky payout test" });
const turn    = await session.submit({ author: bob, text: "also bump the timeout" });
for await (const ev of session.events({ from: turn.queuedSeq })) render(ev);
const pr      = await session.publish({ opener: actor });
```

The entire Slack integration is one `inspect.dispatch(message)` call that classifies the repo,
opens the workspace, finds-or-starts the session for that thread, joins the speaker and queues
the prompt — with `ambiguous` as a first-class return so the bot can ask instead of guess. The
web server adds exactly one idea: `view()` for a cold render plus `events({ from })` for the
warm tail, which is the whole client sync protocol and covers page reload, WebSocket
hibernation wake-up and Slack card re-render with the same two calls. The test harness runs the
same path against directories and tarballs and asserts the write gate by observing
`["stale", "syncing", "fresh"]` on the stream.

Nowhere in any of the three call sites does a caller mention a sandbox, a snapshot, a sync, a
pool, a lease, a token or an image.

## Shape

**Axis D — workspace-first.** `Workspace` is the root aggregate: repo plus image lineage plus
warm pool plus snapshot store plus branch namespace plus forge installation. `Session` is a
short-lived lease on one slot of that workspace, plus the conversation that borrowed it.
Sessions are created by workspaces, hold a fenced `SlotLease`, and can be parked and resumed
without the caller knowing which way the slot came back.

The data structures come first and the code follows from them.

`ImageGeneration.baseCommit` is the single source of truth for staleness. `Freshness` —
`unknown | stale | syncing | fresh | diverged` — is *derived* from that commit against observed
origin head, and is never stored on a session. That one choice removes the whole class of bugs
where a session's idea of "am I synced" drifts from the sandbox's, and it is only available
because the thing that knows the baked-in commit is the repo-scoped aggregate, not the session.

The gate is encoded in the type system rather than checked. `LeasedSlot` carries `read`,
`list`, `run(ReadOnlyCommand)` and `watch` — everything that is safe against a stale tree, which
is exactly the capability the article says the agent gets at t=0. `MutableSlot` carries `write`,
`commit`, `push` and `run(MutatingCommand)`, and the only way to obtain one is
`await slot.admitWrites()`. There is no `if (!synced) throw` in the system, and no caller can
forget the check because there is nothing to forget: the write methods do not exist until the
gate opens, per encode-lessons-in-structure. The OpenCode `tool.execute.before` plugin becomes
three lines — classify the call, await `gate.admit`, proceed — and holds no timer, no retry loop
and no copy of the freshness state.

The credential invariant is a brand split. `InstallationToken` and `UserToken` are distinct
branded strings; `MutableSlot.push` accepts only the first and `ForgePort.openPullRequest`
accepts only the second. "The App clones, the human opens the PR" is a type error to violate.
Application code holds neither: `publish` takes an `Actor` and `authorship/` exchanges it for a
token at the point of use.

Attribution is derived, not synced. A `TurnOutcome` carries the commits that turn produced;
contributors are computed from the turn ledger at publish time. There is no contributor list
maintained beside the queue, so the two cannot disagree.

Branch names are a function of the session id with an inverse, so a GitHub webhook resolves to
a session by parsing the branch — no branch→session index to build, backfill or repair. This is
a workspace-first dividend: webhooks are repo-scoped events, and the repo aggregate already
owns the branch namespace, so routing is local knowledge rather than a global registry.

On shared writes, the question "what happens if both write?" is answered differently in two
places on purpose. The turn queue is serialised through the session actor, because ordering is
the invariant users actually perceive and a merge would produce an order nobody chose.
Presence, drafts, last-seen cursors and composing state are kept as one record per
`(actor, surface)`, never merged on write, and merged at the read boundary by
`mergeParticipants` — so the same human on Slack and web cannot clobber themselves, per
separate-before-serializing-shared-state. Warm hints are not session state at all; they go to
the workspace and merge by union, which is why `hint` can be fire-and-forget and idempotent.

Crash semantics get a fencing token rather than a distributed transaction. The workspace is
authoritative for slot ownership; a session holds a lease with an `epoch`, heartbeats it, and
every mutating slot operation carries that epoch so the compute adapter rejects a superseded
one. A session that dies mid-turn loses its lease on TTL and the workspace reaper reclaims the
slot — leaked sandboxes are a real cost problem, and workspace-first puts the reaper in the only
place that can see the whole population.

Validation lives at the edges. `verifyWebhook` parses a GitHub payload into a `ForgeEvent`
union before anything inward sees it; the classifier returns `RepoCandidate[]` and `dispatch`
turns that into a discriminated `Dispatch` rather than a nullable repo; `localPorts` parses the
same shapes from a local bare repo. Inside those boundaries the types are trusted, per
boundary-discipline. Everything genuinely hard is a pure function in §8 of the sketch —
`planAcquisition`, `planPool`, `advanceQueue`, `mergeParticipants`, `nextFreshness`,
`contributorsOf`, `branchOfSession` — so the shells stay thin and the policy is testable against
a fake clock with no I/O.

**Interface depth, judged honestly.** `Workspace` is six methods. Behind them: image rebuild
cadence, pool sizing, warm-on-keystroke, the warm/cold/resume decision, lease arbitration and
fencing, snapshot lifecycle, idle parking, crash reclamation, branch minting and webhook
routing. `Session` is seven methods, and behind them: queue serialisation, multiplayer roster
merge, event sequencing and replay, stop propagation into the runtime, transparent re-acquisition
of a parked slot, and the commit-push-open-attribute sequence collapsed into one idempotent
`publish`. What remains exposed to callers is only what a caller must genuinely decide: which
repo, who is speaking, what the prompt says, and whether the PR is a draft.

What the design deliberately does not do: no interrupt-insert into a running turn; no
cross-workspace sessions; no automatic conflict resolution on `diverged` (it surfaces and asks);
no Chrome MDM, voice, or the full Ramp MCP suite — those arrive through `TurnCapabilities.extraTools`
without `session/` or `workspace/` changing.

## Synthesis decision

N/A — candidate sketch.

## Tradeoffs accepted

- We accept that a session cannot exist without a workspace — including a scratch "just run this
  in a throwaway container" session — in exchange for every staleness, supply and reclamation
  decision having exactly one home.
- We accept a cross-aggregate lease protocol between two Durable Objects, with fencing epochs
  and heartbeats, in exchange for never leaking a sandbox when a session crashes and never
  needing a global slot registry. A session-rooted design avoids the protocol and pays for it
  with orphaned VMs.
- We accept that `admitWrites` can block a turn for the length of a git sync, and that this is
  visible to the user as a parked tool call, in exchange for time-to-first-token being bounded
  by the model rather than by the clone.
- We accept two representations of the participant roster — per-actor records in storage, a
  merged view on read — in exchange for two clients belonging to one human never clobbering each
  other's presence.
- We accept that `Freshness` is recomputed rather than cached on the session, which costs an
  origin-head lookup on acquisition, in exchange for it being impossible for a session and its
  slot to disagree about whether writes are safe.
- We accept that `planPool` is a real policy function with a burst term on day one, which looks
  like premature optimisation at hatch scale with `target: 0`, in exchange for warm-on-keystroke
  not becoming a second code path bolted beside cold boot later.
- We accept that the local adapters are a substantial build — real child processes, real git,
  real tarball snapshots — rather than trivial mocks, in exchange for the gate, the reaper and
  the resume path being exercised by tests instead of only by production.

## Alternatives considered

**Session as the root aggregate, pool as an infrastructure service underneath.** The natural
shape: `Session` owns its sandbox handle and asks a `SandboxService` for a VM. It loses on
interface depth in a specific way — the pool, the image generation and the snapshot store are
shared mutable state that no session owns, so either every session coordinates with a service
that is really a second aggregate wearing a service's clothes, or reclamation and pool expiry
end up as a cron job outside the model. It also has no natural owner for repo-scoped webhooks,
which pushes a global branch→session index into existence. It hides slightly less and exposes a
`sandbox` handle that callers eventually reach into.

**Event-sourced session log as the source of truth, with sandbox and agent as subscribers.**
Genuinely attractive for the multiplayer and replay requirements: `view()` and `events({from})`
fall out for free, and audit is exact. It lost on the gate. A write gate is a synchronous
question — "may this tool call proceed right now?" — and answering it from a projection means
either blocking on projection catch-up or letting the agent write against a stale read of its
own permission. The sketch keeps the log (the transcript is append-only with sequence numbers)
without making it the authority for anything that has to be answered synchronously.

**Capability objects minted by a factory, with no session facade** (`PromptHandle`,
`SandboxHandle`, `PublishHandle`). Excellent for least privilege and for the agent's reachback
surface — which is why `TurnCapabilities` is exactly this shape. As the *public* surface it
inverts the depth we want: the Slack integration would mint and thread three or four handles to
do what `dispatch` now does in one call, and the caller would be back to coordinating the
warm/sync/publish sequence themselves. Capability objects won inside the boundary and lost at it.

**A single `Inspect` god-object with `startSession`, `prompt`, `stream`, `openPr` as flat
methods.** Simplest to implement and the smallest type sketch. Rejected because it has nowhere
to put the repo-scoped state, so pool, generations and leases become module-level singletons —
untestable in parallel, and the reason a second repo or a second test file breaks it.

## Open questions and risks

- Cross-DO leasing is the riskiest mechanism here. Should the workspace live in one Durable
  Object per repo, with the risk that a very high-traffic repo serialises all its lease traffic
  through one object, or should the pool be sharded by generation with a lease broker in front?
- Reads before sync are safe for the filesystem but may be *misleading* for the model: the agent
  can read a file, reason about it, and only then discover the sync rewrote it. Should
  `admitWrites` invalidate the agent's context for files that changed during the sync, or is
  surfacing a `tool.parked` delta and letting the model re-read enough?
- `share-parent-slot` child sessions put two agents on one filesystem. The sketch blocks the
  parent's queue while a sharing child runs. Is that the right default, or should sharing
  children be dropped from v1 and only `sibling-slot` fan-out shipped?
- When a parked session resumes and its snapshot's image generation has since expired, we can
  resume the stale snapshot (correct edits, old dependencies) or cold-boot and replay the diff
  (fresh dependencies, risk of losing uncommitted state). Which does the user expect after a
  two-hour Slack gap?
- On `diverged`, the sketch surfaces conflicts and stops. Should the agent be given the conflict
  and asked to resolve it, given that it is a coding agent and this is a coding task?
- Where does `WorkspacePolicy` come from — a checked-in file in the repo, a dashboard, or
  inferred from the repo's own CI config? The sketch takes it as a constructor argument and
  dodges the question.
- Should `Session.publish` be callable by any participant, or only by the opener? The sketch
  allows any participant and takes the opener from the request, which means the PR author is
  whoever clicked, not whoever started the session. That is probably right for multiplayer and
  is worth confirming.

## Next implementation step

Build `planAcquisition`, `planPool` and `nextFreshness` as pure functions plus the local
`ComputePort` with a configurable sync delay, and drive them from the call-site-3 test until the
event stream emits `stale → syncing → fresh` and an edit issued at t=0 lands after the sync.
