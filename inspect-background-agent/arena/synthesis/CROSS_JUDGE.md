# Cross-judge — Inspect background agent arena

Four candidate design packages read end-to-end against the rubric in
[`FRAME.md`](../FRAME.md) and the screening list in
[`design-red-flags.md`](../design-red-flags.md).

**Base: candidate 4 (axis D, workspace-first).** Rationale in §3.

Artifact note: candidate 4 ships no `SELF_CHECK.md`. Its `MODULES.md` and `RATIONALE.md`
contain red-flag reasoning, but that reasoning is self-justifying rather than adversarial —
it argues why each boundary is *not* a temporal decomposition and never names a weakness of
its own. That costs it criterion 6 and it is the only place it loses.

---

## 1. Scores

| # | Criterion | C1 actor | C2 event log | C3 capability | C4 workspace |
| --- | --- | :---: | :---: | :---: | :---: |
| 1 | Multi-client create → prompt → stream → PR, no Modal/DO/OpenCode wire types | 5 | 4 | 3 | 5 |
| 2 | Types encode lifecycle, authorship, sync gate, prompt queue | 4 | 5 | 3 | 5 |
| 3 | Modules group by ownership, not pipeline stage | 5 | 4 | 4 | 5 |
| 4 | Interface depth — callers don't coordinate warm/sync/snapshot | 5 | 4 | 3 | 5 |
| 5 | Hatch-scale ports/adapters for local fake backends | 4 | 5 | 3 | 5 |
| 6 | Honest self-check against red flags | 5 | 4 | 3 | 2 |
| | **Total** | **28** | **26** | **19** | **27** |

The 28/27 split between C1 and C4 is entirely criterion 6, which measures a missing
document rather than a property of the design. On the criteria that measure the design —
2, 4, 5 — C4 leads or ties everywhere. See §3 for why that decides it.

---

## 2. Strengths and weaknesses

### Candidate 1 — session-as-actor

**Strengths.** Smallest public surface of the four: `SessionHub` (4 methods) plus
`SessionHandle` (8) and one event union, and that surface really does hide warm pools,
image rebuild, snapshot resume, queue pumping and token exchange. The lifecycle model is
the sharpest piece of type design in the arena — `SyncGate` is a *field* of the `live`
phase rather than a phase of its own, which correctly encodes that the agent runs
reads-only while sync is in flight, and `hibernated` structurally cannot exist without a
resume snapshot. Authorship lives on `PromptRecord`, so multiplayer attribution and PR
co-author trailers are derivations rather than a second list to keep in sync. Branch names
derive from `SessionId` in both directions, so webhook routing is a pure function with no
index. `SELF_CHECK.md` is the most honest document in the arena: it names `hub.warmHint`
as a probable pass-through, flags that `SessionView` ships the internal `SessionPhase`
shape to clients, and admits `ChildSpawner.spawn` is borderline — findings a judge would
otherwise have to discover.

**Weaknesses.** The write gate is advisory. `SessionCapabilities.gate()` is a polling read
that the OpenCode plugin is trusted to consult before every tool call; the rationale
concedes a few hundred milliseconds of staleness. Nothing in the types stops a write
against an unsynced tree. More structurally, the design has no home for repo-scoped state.
Image lineage, warm pool, pool expiry on rebuild and org stats are all pushed behind
`SandboxFleet`, and the rationale says so explicitly — "this candidate keeps that value by
making `SandboxFleet` own the same knowledge privately." That makes `SandboxFleet` a
workspace aggregate without a record, without a policy object and without a reaper: there
is no answer to what happens to a Modal sandbox when the actor dies holding it. The actor
takes eight dependencies and is acknowledged as the god-object risk. `stop` pausing the
queue forces a `resumeQueue` method onto the public surface that no other candidate needs.
`UserToken` is branded but the installation token used for clone and push is not, so the
headline product invariant — the human opens the PR, never the app — rests on convention.

### Candidate 2 — event-sourced journal

**Strengths.** The richest type encoding: a non-empty tuple for the waiting queue
(`readonly [QueuedPrompt, ...QueuedPrompt[]]`), `EventOrigin` provenance on every envelope,
`SyncGateView` with `readsAllowed: true` in both arms, typed `DomainRejection`, and PR
state as a five-arm progression from `requested` through `branch-pushed` to `open`. It is
the only candidate that takes crash-in-the-middle-of-a-remote-call seriously:
`EffectId` is threaded into every provider port and the `EffectLedger` doc comment is
honest that a local ledger cannot close the window alone. Authorship is handled well —
`openPullRequest` stores an opaque `AuthorizationGrantId` and the note that no OAuth token
ever enters the journal is a genuine security property, not a comment. The local kit is
complete and deterministic, with `settle()` for tests and a named fake per port. The
sketch was type-checked under strict mode.

**Weaknesses.** The command layer is ceremony. `SessionCommand` mirrors `SessionEvent`
almost one-for-one — roughly 25 commands against 30 events — and a dozen of those commands
are `Record*` variants that only transcribe an effect that already happened
(`RecordSandboxAvailable`, `RecordGitSyncCompleted`, `RecordBranchPushed`). A decider that
rubber-stamps a recording of the past is the pass-through pattern at the scale of a whole
layer, and the self-check defends `SessionCommandService.execute` without confronting it.
The caller pays too: `openPullRequest` returns a receipt, so the quickstart opens a second
`watch` loop just to learn the PR URL, and every method demands a `requestKey`. Splitting
`session-domain` / `session-journal` / `session-application` / `session-projections` /
`subscriber-runtime` spreads one session's invariants across five modules; the subscribers
below that line are correctly grouped by ownership, but the top half is layering. And the
gate is answered from a projection, which is the wrong shape for a synchronous permission
question — candidate 4's rationale makes this argument against candidate 2 better than
candidate 2 defends against it.

### Candidate 3 — capability tokens

**Strengths.** The attenuation idea is right and is the one thing this candidate has that
nobody else does at the *client* edge: a GitHub webhook receives a `LifecycleHandle` that
physically cannot enqueue a prompt, and an agent plugin receives a `SpawnHandle` rather
than a session. `PromptHandle` binds an `Author` at mint time, so enqueue cannot be
misattributed. It is also the only candidate to model code-server (`SandboxHandle.ideUrl`),
which the source article calls for. The self-check correctly identifies
`LifecycleHandle.apply` as nearly a pass-through kept only for attenuation.

**Weaknesses.** The public surface leaks in two ways the others do not.
`PullRequestHandle.open({ userGithubToken: string })` takes a raw, unbranded credential
from application code — the quickstart reads it out of `process.env` — which turns a
system-enforced invariant into a caller obligation. And `GitHubWebhookParser.parseWebhook`
takes a `Request` while `GitHubPort.parseAndVerifyWebhook` returns `Promise<unknown>`,
putting a transport type and an untyped payload on port boundaries. Behind the handles sits
`SessionActorPort`, a 17-method port with `setPhase`, `setGate`, `recordBranch`,
`recordPullRequest` — a setter-shaped god-object that the handles mostly forward to.
`EventCursorImpl.subscribe`, `SandboxHandleImpl.phase` and `SpawnHandleImpl.status` are
literal one-line forwards. So the capability bundle buys attenuation at the cost of
scattering one session's state behind a wide mutable port, which is the trade the red-flags
doc warns about. The caller also assembles more than anywhere else: mint, then `hintWarm`,
then enqueue, and the web route hands the browser four separate grant tokens.
`memoryAdapters()` is a single function body containing a TODO, so criterion 5 is asserted
rather than designed. The `## Rubric touch` section reads as checklist-answering.

### Candidate 4 — workspace-first

**Strengths.** It gets the root noun right, and that is the hardest thing here to retrofit.
Almost nothing expensive or invariant-bearing in Inspect is session-scoped: image lineage,
warm pool, staleness horizon, branch namespace, installation token, webhook feed, leaked-
sandbox reclamation and org stats are all per-repo and shared across sessions that never
meet. Candidate 1 hides these inside `SandboxFleet` and candidate 2 scatters them across
subscribers; candidate 4 gives them one record, one policy object and one reaper.

The write gate is enforced by the type system rather than checked. `LeasedSlot` exposes
`read`, `list`, `run(ReadOnlyCommand)`; `MutableSlot` exposes `write`, `commit`, `push`,
`run(MutatingCommand)`; and the only constructor for a `MutableSlot` is
`await slot.admitWrites()`. There is no `if (!synced) throw` anywhere and no caller can
forget the check, because the write methods do not exist until the gate opens. The
credential invariant gets the same treatment: `InstallationToken` and `UserToken` are
distinct brands, `MutableSlot.push` accepts only the first and `ForgePort.openPullRequest`
only the second, so "the App clones, the human opens the PR" is a compile error to violate.
Application code holds neither — `publish` takes an `Actor` and the exchange happens
inside.

It is the only candidate whose `Freshness` union includes `diverged` with the conflicting
paths, which is the actual failure mode of resuming a thirty-minute-stale snapshot, and the
only one with lease epochs, heartbeats and a reaper — an answer to what happens to the VM
when a session dies mid-turn. `Freshness` is derived from `ImageGeneration.baseCommit`
against observed origin head and never stored on the session, so a session and its slot
cannot disagree about whether writes are safe. Contributors are derived from the turn
ledger, branch names from the session id with an inverse. The shared-write question is
answered twice on purpose and both answers are argued: the turn queue is serialised because
ordering is what users perceive, while presence and drafts are per-`(actor, surface)`
records merged on read by `mergeParticipants`.

Everything genuinely hard is a pure function with no I/O in §8 — `planAcquisition`,
`planPool`, `advanceQueue`, `nextFreshness`, `mergeParticipants`, `contributorsOf` — which
makes the policy unit-testable against a fake clock and keeps the shells thin. The local
harness is the only one built to *prove* the gate rather than assert it: `gitFixture` can
move origin forward mid-session, `localPorts({ compute: { syncDelayMs, staleBy } })` boots
deliberately stale slots, and the call-site-3 test asserts
`["stale", "syncing", "fresh"]` off the public event stream. `scriptedAgent` takes
domain-level steps, so a gate test never touches an OpenCode frame. Interface depth is the
best of the four: the entire Slack integration is one `dispatch` call with `ambiguous` as a
first-class return, and `view()` plus `events({ from })` is the whole client sync protocol
for page reload, WebSocket hibernation wake-up and Slack card re-render alike.

**Weaknesses.** No `SELF_CHECK.md`, and the substitute prose never says "this part of my
design is weak." Largest total surface: `Inspect` (5) + `Workspace` (6) + `Session` (7),
against candidate 1's 12 methods. Cross-aggregate leasing between two Durable Objects is
the riskiest mechanism proposed anywhere in the arena, and the rationale admits it without
resolving whether a hot repo serialises all lease traffic through one object.
`AggregateStore.appendEvents(events: readonly unknown[])` and
`BusPort.subscribe(): AsyncIterable<unknown>` put `unknown` on port boundaries, which
pushes casts back into the core — the one place the boundary discipline slips.
`Inspect.dispatch` folds repo classification into the root object, which is a Slack-shaped
concern sitting on the top-level surface. `PublishRequest.opener` is misnamed: the field is
whoever is publishing now, not whoever started the session, and the rationale's own open
question shows the author knows it. Sessions cannot exist without a workspace, so there is
no throwaway-container path.

---

## 3. Recommended base: candidate 4

Take candidate 4 whole. Do not average it with candidate 1.

The rubric totals put candidate 1 one point ahead, and that point is the missing
self-check. A missing document is a cheap defect: writing an honest red-flag screen against
candidate 4 costs an afternoon and changes nothing about the shape. The defects that
separate the two designs run the other way, and they are the expensive kind.

**The gate.** Candidate 1's write block is a value the plugin is trusted to read; candidate
4's is a type the caller cannot obtain early. Retrofitting `admitWrites` into candidate 1
means changing what a sandbox handle *is*, and every call site that touches it. Adding
candidate 1's polling gate to candidate 4 would be a downgrade nobody would propose.

**Repo-scoped ownership.** Candidate 1's own rationale concedes that `SandboxFleet` owns
the workspace's knowledge privately. That works until the first thing that needs the whole
population rather than one sandbox: reclaiming a leaked VM after a crash, expiring the pool
on an image rebuild, sizing the pool from keystroke demand, or answering "how many humans
prompted in the last five minutes." Each of those arrives as a cron job or a module-level
singleton beside the model. Candidate 4 has one record, one policy object and one reaper
from the start, and `planPool` makes warm-on-keystroke the same decision as pool expiry
instead of a second code path. Growing that aggregate into candidate 1 later means moving
state out of a port and inventing a lease protocol under load — exactly the migration you
do not want to discover in production.

**Extension without breaking invariants**, which is the tiebreak the brief asks for. In
candidate 4 the invariants a future maintainer could break are mostly unbreakable: writes
against a stale tree do not typecheck, an app-token PR does not typecheck, contributors
cannot drift from the turn ledger because they are derived from it, and a webhook cannot
route wrong because the branch name carries the session id. The named extension points are
real — `TurnCapabilities.extraTools` absorbs the whole Ramp MCP suite and the computer-use
tools without `session/` or `workspace/` changing, the `Attachment` union absorbs the
Chrome extension's DOM selection, `ClientSurface` absorbs new clients, and every port has a
deployed/local adapter pair. In candidate 1 the same features arrive as new methods on
`SessionActor`, which the author already flags as the god-object risk of the axis.

The "prefer the smaller public surface when tied" clause does not apply, because these are
not tied on design quality. Candidate 1 is smaller and candidate 4 is deeper, and the extra
surface in candidate 4 is `Workspace` — the aggregate candidate 1 needs and does not have.
That said, the clause should still discipline the base: `Slot` types must not be exported
from `index.ts` as the module map promises, and `Inspect.dispatch` should be reviewed
against candidate 1's pass-through audit before it becomes the third public entry point.

---

## 4. Grafts

### From candidate 1

1. **The actor mailbox as the concrete mechanism for queue serialisation.** Candidate 4
   asserts that the turn queue is "serialised through the session actor" but never shows
   how. Port candidate 1's `SessionCommand` union plus the single-writer mailbox and the
   `SessionStore` port (`load` / `save` / `append` / `read`) as the implementation of
   `session/`. It fills a real hole, it is Durable-Object shaped, and it is the piece that
   makes "one writer per session state" checkable rather than aspirational.
2. **`childStatus` on the agent's capability bundle.** Candidate 4's `TurnCapabilities`
   lets an agent spawn a child and gives it a budget, but gives it no way to read the
   child's progress — so a fan-out turn can start work it cannot observe. Candidate 1's
   `caps.childStatus(id) => SessionView` closes that, and its `ChildSpawner` is the right
   place to hang a spawn-depth limit, which candidate 4's `budget` does not cover.

### From candidate 2

1. **`EffectId` threaded through every provider port.** Candidate 4 has fencing epochs for
   slot ownership but nothing for the crash window around boot, push, PR-open and agent
   start. Adopt candidate 2's deterministic effect ids derived from the event that caused
   them, and its honesty that a local ledger only works if each adapter uses the id as the
   provider's idempotency key. This is the strongest single idea in candidate 2 and it
   grafts cleanly onto `ComputePort`, `ForgePort` and `AgentRuntime` without importing the
   journal.
2. **`EventOrigin` provenance on `SessionEvent`.** Candidate 4's events carry `seq` and
   `at` but not who or what produced them. Adding a `user | agent | sandbox | webhook |
   system` discriminant makes a multiplayer transcript renderable without inference, and
   makes "which subscriber wrote this" answerable during a postmortem. Cheap, additive,
   and it pairs with `AgentDelta` already being domain-level. Take `settle()` from
   candidate 2's local harness at the same time — candidate 4's `fakeClock.advance` covers
   timers but not in-flight subscriber work.

### From candidate 3

1. **Attenuated grants at the untrusted client edge.** Candidate 4 is capability-shaped
   *inside* the boundary (`TurnCapabilities`) but its clients hold a full `Session`. For
   the browser SSE stream and for anything handed to a third-party surface, mint a scoped,
   revocable read-only grant in candidate 3's style, rather than authorising a route that
   could also `submit` or `publish`. Keep it to the stream; do not adopt the four-grant
   handoff from candidate 3's web route.
2. **`ideUrl` / code-server exposure.** Candidate 3 is the only candidate that models the
   in-sandbox IDE the article calls for. Add it to `LeasedSlot` with a projection onto
   `SessionView`, so the web client can offer "open in code-server" without gaining a slot
   handle.

---

## 5. Rejected

**Candidate 3's raw `userGithubToken: string` on `PullRequestHandle.open`.** Unbranded
credential on the public surface, sourced from `process.env` in application code. It
inverts the product invariant candidate 4 makes a compile error, and it puts a secret in
every caller that opens a PR. Candidate 4's `Actor` in, `UserToken` exchanged internally is
strictly better.

**Candidate 3's `Request` and `Promise<unknown>` on the webhook ports.** A transport type
and an untyped payload crossing a port boundary is the leakage the red-flags doc names
directly. Keep candidate 4's `RawWebhook` in, `Result<ForgeEvent, …>` out.

**Candidate 3's `SessionActorPort`.** Seventeen methods, setter-shaped (`setPhase`,
`setGate`, `recordBranch`, `recordPullRequest`), with handles that forward to it. Adopting
any of it would undo the ownership split between `workspace/`, `slot/` and `session/`.

**Candidate 2's command layer.** Keep the journal idea if the transcript needs it; reject
`SessionCommand` as a distinct union. Twelve `Record*` commands that transcribe effects
already completed, routed through a decider that can only accept them, is a whole layer of
pass-through. At hatch scale the audit value does not pay for it, and candidate 4 already
has an append-only transcript with sequence numbers.

**Candidate 2's receipt-only `openPullRequest`.** Forcing a second `watch` loop to learn
the PR URL is caller coordination dressed as asynchrony. `publish(): Promise<PullRequestView>`
is the right signature.

**Candidate 2's event log as the authority for the sync gate.** Candidate 4's rationale
already argues this correctly: a write gate is a synchronous question — may this tool call
proceed right now — and answering it from a projection means either blocking on catch-up or
letting the agent write against a stale read of its own permission. Keep the log for the
transcript; do not make it the authority for anything answered synchronously.

**Candidate 1's `caps.gate()` polling plugin.** Superseded by `admitWrites`. Also drop the
`stop` → `resumeQueue` pairing that comes with it; candidate 4's
`stop({ scope: "current-turn" | "queue" })` needs no unpause method.

**Merging axes.** Do not build a workspace aggregate over an event-sourced journal with
capability handles on top. Each candidate's coherence is load-bearing, and the composite
would carry candidate 2's command ceremony and candidate 3's grant plumbing into a design
whose depth comes from having neither.

**One defect in the base to fix rather than graft around:** `AggregateStore.appendEvents`
and `BusPort.subscribe` traffic in `unknown`. Type them against the session and workspace
event unions before any adapter is written, or the casts will land in `session/` and
`workspace/` where the boundary discipline says they must not.
