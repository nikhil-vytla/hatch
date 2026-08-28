# Rationale — candidate 1

## Problem

Build a hatch-scale replica of Ramp's Inspect background agent: sandboxed sessions that
boot from repo image snapshots, accept prompts from several clients at once (web,
Slack, future extension), stream state back in realtime, and open PRs as the human —
all runnable locally without Modal or Cloudflare credentials. The shape is non-obvious
because three concerns tangle: multiplayer writes (several humans prompting one
session), a sandbox lifecycle with async gates (reads allowed before git sync
completes, writes blocked), and a fan-in/fan-out topology (webhooks in, child sessions
out). Constraints from the spec that the design must honor: prompt queueing rather
than interruption, stop mid-run, PR authorship with the user's token, snapshot-resume
after sandbox exit, and warm-on-keystroke.

## Usage (caller's view)

Written first; see [USAGE.md](USAGE.md). Quickstart plus three call sites: web routes
(create/prompt/stream/stop with idempotency keys), the Slack adapter (thread↔session
mapping, classify-then-create, event rendering), and the GitHub webhook route (parse
at boundary, route by derived branch name). The public surface is two interfaces —
`SessionHub` and `SessionHandle` — and the `SessionEvent` union.

## Shape

Axis **A — session-as-actor**. Data structures first: `SessionState` is the single
authoritative record — phase, prompt history, pause flag, PR ref — persisted by a
per-session store (Durable Object–shaped). One `SessionActor` per session is the only
writer; every mutation is a `SessionCommand` through its mailbox, so multiplayer
writes serialize by construction (per separate-before-serializing-shared-state: the
actor is the merge point, clients own nothing). Reads flow the other way as an
append-only `SessionEventEnvelope` log with monotonic `EventSeq` — a projection of
actor transitions, not the source of truth — giving every client the same
replay-then-tail stream and making reconnect trivial (`since: seq`).

Load-bearing decisions, each encoded in types rather than checked at runtime:
lifecycle is a discriminated `SessionPhase` where a run and a sync gate can only exist
inside `live` (the gate is a field of the live phase, not a phase itself, because the
agent legitimately runs reads-only while sync is in flight); attribution lives on
`PromptRecord`, never on the session, so multiplayer authorship and PR co-author
trailers are derivations; the branch name derives from `SessionId`, so webhook routing
is a pure function with no mapping table to drift (single source of truth, derive
instead of sync). Ids are branded; wire formats (OpenCode deltas, Modal handles,
octokit payloads, Slack events) are parsed into domain types inside their adapters and
never appear on a port (per boundary-discipline).

Interface depth: the surface is eight methods across hub and handle, and behind it sit
warm pools, image rebuild loops, snapshot boot/resume, the sync gate, queue pumping,
stop semantics, and token exchange. `SandboxFleet.acquire` is the depth move — one
call returns a booted sandbox with the agent server running and sync started;
resume-vs-warm-vs-cold is invisible even to the actor. `enqueue` on a hibernated
session revives it transparently; callers never branch on phase. What remains exposed
is deliberate: `resumeQueue` (stop pauses the queue; someone must be able to unpause
without prompting) and `warmHint` (keystroke timing is client knowledge). Mutating
entry points are idempotent — `create(idempotencyKey)`, `enqueue(dedupeKey)`,
`ensurePullRequest` by branch, `hibernate` re-runnable after a crash (per
make-operations-idempotent). The system deliberately does not do: interrupt-insert
prompts, app-authored PRs, cross-session queries (org stats is a listed extension, not
designed), or Chrome MDM/voice/MCP suites.

## Synthesis decision

N/A — candidate sketch.

## Tradeoffs accepted

- We accept a large `SessionActor` (queue + gate mirroring + agent loop + PR flow) in
  exchange for a two-interface public surface and single-writer simplicity; the god-
  object risk is contained by pushing sandbox/image knowledge behind `SandboxFleet`
  and wire translation behind `AgentRuntime`.
- We accept that events are a replay window, not an event-sourced source of truth, in
  exchange for a simpler recovery story (state row wins); a client that outlives the
  replay window must re-fetch `view()` and resubscribe.
- We accept serialized command handling per session (an actor processes one command at
  a time) in exchange for never reasoning about concurrent state transitions; at
  Inspect scale, per-session throughput is human-paced.
- We accept a deterministic branch naming scheme (`inspect/{id}`) in exchange for
  table-free webhook routing; users who rename the branch break the webhook link
  (mitigable later by also matching PR head SHA).
- We accept polling-shaped `caps.gate()` for the write-block plugin in exchange for
  keeping the runtime port free of session callbacks; the gate flips once per session,
  so staleness risk is a few hundred milliseconds on one tool call.

## Alternatives considered

- **Session-as-event-sourced log** (axis B): the log as source of truth with
  projections for UI and agent. Deeper audit story, but every consumer inherits
  projection/replay machinery, and the sandbox — inherently stateful, snapshot-based —
  fits poorly as a "subscriber"; gate and gate-enforcement would live in different
  modules, leaking the sync decision across boundaries. More exposed complexity for
  the same caller value.
- **Capability handles, no session facade** (axis C): minting `PromptHandle` /
  `StreamHandle` per operation gives finer-grained auth, but callers must correlate
  handles that all refer to one underlying session, and multiplayer state ("is it
  running? who paused it?") has no home the caller can ask. Shallower: interface
  grows with each capability while hiding less per method.
- **Workspace-first** (axis D): repo+image+pool as root aggregate with sessions as
  leases. It models the image pipeline well, but the dominant access pattern here is
  session-scoped (prompt, stream, stop, PR), and axis D pushes a two-step
  resolve-workspace-then-lease onto every caller. This candidate keeps that value by
  making `SandboxFleet` own the same knowledge privately.

## Open questions and risks

- Stop currently pauses the queue and any later `enqueue` unpauses it. Is auto-unpause
  the right multiplayer behavior, or should a stopped session require an explicit
  `resumeQueue` even when a new prompt arrives?
- `openPullRequest` uses the requesting author's token. When another author's prompts
  produced most commits, is requester-authorship plus co-author trailers acceptable,
  or should the PR author be the majority contributor?
- Should child sessions inherit the parent's authors and event stream visibility, or
  is a `child.spawned` event plus `childStatus` polling enough for the fan-out UX?
- The replay window (`SessionPolicy.eventReplayWindow`) trades storage against
  reconnect UX. Is "full log for the session's lifetime" acceptable at hatch scale so
  the window question disappears?
- For the local fleet, is a real-git-in-temp-dir fake worth the setup cost versus an
  entirely in-memory filesystem fake? (The sketch assumes real git — it exercises the
  sync gate honestly.)

## Next implementation step

Implement `session/state.ts` (types + pure transition and derivation functions) with
unit tests for enqueue/stop/pump/hibernate transitions, since every other module
consumes those types.
