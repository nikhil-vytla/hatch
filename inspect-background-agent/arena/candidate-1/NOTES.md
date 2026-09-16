# Candidate 1 working notes — axis A: Session-as-actor

Scratch log for this candidate. The deliverables are USAGE.md, SKETCH.ts, MODULES.md, RATIONALE.md, SELF_CHECK.md.

## Decisions made while sketching

- **Single writer per session.** All mutation flows through one `SessionActor` mailbox
  (Durable Object–shaped). Clients never share mutable state; the actor is the merge
  point. This is the actor-model answer to separate-before-serializing-shared-state.
- **Gate is orthogonal to run.** First draft had `warming | ready | running | stopping`
  phases; that was wrong because Ramp's spec allows the agent to *run* (reads only)
  while git sync is still in flight. Fixed by making `SessionPhase.live` carry both a
  `gate: SyncGate` and an optional `run: ActiveRun`. Invariant now in the type: no run
  and no gate without a live sandbox.
- **Derive, don't store:** branch name derives from `SessionId` (`inspect/{id}`), which
  makes webhook→session routing a pure function instead of a mapping table. Queue
  position derives from array order. Session authors derive from creator + prompt
  records.
- **Stop semantics:** stop cancels the running prompt and pauses the queue. Any later
  `enqueue` (fresh intent) or explicit `resumeQueue` unpauses. Rejected "stop clears
  queue" because in multiplayer it would delete other authors' queued prompts.
- **Status tool decoupling:** the agent's "post status" tool does NOT call Slack. It
  emits an `agent.status` SessionEvent; the Slack adapter (and web) render it. Session
  stays client-agnostic.
- **`SandboxFleet.acquire` is the depth move:** one call returns a booted sandbox with
  the agent server running and git sync already started. Warm pool, image registry
  freshness, snapshot-vs-image boot are all invisible to the session actor.
- **PR opening is an actor method** (`openPullRequest`), reachable from clients and
  from an agent tool alike. Sandbox pushes the branch; the actor asks the vault for
  the requesting author's token and calls `ensurePullRequest` (idempotent by branch).

## Things I tried and discarded

- Exposing `SandboxHandle` on the public surface — violates axis A (clients are thin
  event sources) and leaks lifecycle coordination to callers.
- A separate `warming` phase — replaced by gate-inside-live (see above).
- Storing a branch→session table for webhooks — replaced by derivation.
- `session.join(author)` — authors are derivable from prompts; dropped the method.

## Risks logged for RATIONALE

- Actor is the god-object risk of axis A; mitigated by pushing sandbox/image/pool
  complexity behind `SandboxFleet` and agent wire mapping behind `AgentRuntime`.
- Crash-halfway on hibernate: snapshot taken but phase not persisted → re-snapshot is
  idempotent (last write wins); noted in sketch TODOs.
