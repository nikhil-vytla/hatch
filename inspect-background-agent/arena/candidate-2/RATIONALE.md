# Rationale

## Problem

Inspect must keep one coding session coherent across web, Slack, agent, sandbox, and GitHub activity. Concurrent authors can queue prompts while a sandbox boots, git sync must allow reads but block writes, and remote effects can finish just before a worker crashes. Cloudflare Durable Objects, Modal, OpenCode, and GitHub each have different protocols, yet a local build must run without any of them. The design needs one durable account of what happened without turning the public session API into a remote-infrastructure control panel.

## Usage (caller's view)

The caller creates a user-bound client, records intent, and watches product updates:

```ts
const { sessionId, cursor } = await inspect.sessions.create({
  repository,
  requestKey,
});
await inspect.sessions.submitPrompt({ sessionId, text, requestKey: promptKey });

for await (const update of inspect.sessions.watch({ sessionId, after: cursor })) {
  render(update);
}

await inspect.sessions.openPullRequest({ sessionId, title, requestKey: prKey });
```

The web call site sends `noteDraftActivity` on the first edit to warm the session. Two authenticated clients can submit to the same session; journal order becomes queue order. The Slack call site stores `SessionId` against a verified thread and invokes the same methods with the linked user's identity. A PR request uses that caller's server-side GitHub grant. `USAGE.md` contains all three call sites and the credential-free local equivalent.

## Shape

This candidate takes axis **B, session-as-event-sourced log**. Each session has one append-only journal. `SessionEventEnvelope` carries a monotonic revision, origin, request key, and a domain event. `decideSessionCommand` and `evolveSession` are pure functions. Repository image choice, prompt authorship, queue claims, sync completion, resume snapshots, branch push, and PR lifecycle are facts in the stream. Projection tables and request-key indexes can be rebuilt; they are not alternate session state.

The main structures match the dominant reads. A per-session sequencer handles command decisions and gives concurrent prompt submissions one order. The UI folds a `SessionView`, the agent folds an `AgentInboxProjection`, sync-gate checks read a small gate projection, and webhooks use a rebuildable provider-PR index. Subscribers never edit projections. They append typed commands, so two workers can race without overwriting each other's state. The journal accepts only one legal queue claim. This follows single-source-of-truth and separate-before-serializing-shared-state: producers keep independent immutable facts, and only the per-session journal merges them into order.

The sandbox and agent are at-least-once subscribers. Session creation, draft activity, or queued work causes the sandbox subscriber to boot from the captured repository image or latest resume snapshot. `SandboxBecameAvailable` lets the agent start reading. `GitSyncCompleted` changes the gate to writable; the OpenCode sync plugin rejects writes before then. `PromptRunStarted` is the durable claim for the oldest prompt, while `StopRequested` targets only that run. Status and child-spawn plugins append events instead of reaching into client state.

A PR request stores its author and an opaque authorization grant. The sandbox subscriber pushes first and records `BranchPushed`. The GitHub subscriber resolves the grant and opens the PR as that author, then webhook ingress records later lifecycle changes. Remote operations receive deterministic effect ids. This makes retries safe when adapters honor provider idempotency, per make-operations-idempotent.

Boundary adapters validate unknown HTTP, Slack, GitHub, Modal, and OpenCode data before producing domain values, per boundary-discipline. The public interface has five intents, one query, and one stream. That small interface hides boot, warm, sync, scheduling, snapshots, push ordering, credentials, and retries. Idempotency keys and cursors remain exposed because callers need stable retry and resume semantics. No provider type crosses the interface.

Chrome MDM, voice, and a full MCP catalog are omitted. Future clients enter through `SessionsClient`, and future agent tools enter through `AgentPlugin`, without changing the journal contract.

## Synthesis decision

N/A — candidate sketch

## Tradeoffs accepted

- We accept one serialized append point per session in exchange for deterministic multiplayer and queue order.
- We accept eventually consistent projections and subscriber effects in exchange for replay, crash recovery, and independent adapters.
- We accept event-schema evolution work in exchange for an auditable source of truth that can rebuild every view.
- We accept a larger journal when agent output is recorded in chunks in exchange for resumable realtime streams; retention and chunk compaction need explicit limits.
- We accept that an authorization grant may expire before PR creation in exchange for never persisting a user OAuth token in the session log.

## Alternatives considered

- A stateful session actor could own the queue, sandbox handle, stream, and PR flow. Its public interface could stay small, but restart recovery would depend on actor snapshots and hidden mutable state. The event log gives subscribers durable work and makes local replay the same mechanism as production recovery.
- Capability objects such as `PromptHandle` and `SandboxHandle` could narrow each method set. They would expose lifecycle coordination to web and Slack callers, especially resume, stop, and PR ordering. The chosen session intents hide more policy with fewer concepts.
- A job pipeline split into boot, sync, run, push, and open-PR stages would simplify each worker. It would repeat session invariants across temporal modules and force callers or an orchestrator to understand stage order. Ownership-based subscribers keep those policies with sandbox, agent, and GitHub knowledge.

## Open questions and risks

- How many output events may one session retain before chunks move to content-addressed blob storage while their references remain replayable?
- What projection lag is acceptable for sync-gate checks, or should that one projection fold directly from the journal tail?
- How long should a user authorization grant remain valid, and what UI recovery should follow an expired grant?
- Which idle signal should trigger a resume snapshot when queued prompts, child sessions, or an open PR still need the sandbox?
- Should sessions allow a second PR after the first closes, or is one PR per session a product invariant?

## Next implementation step

Build the in-memory journal, pure decider and reducer, and replay tests for concurrent prompt submission, write gating, stop, and idempotent PR requests.
