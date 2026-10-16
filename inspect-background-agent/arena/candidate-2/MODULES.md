# Module map

The names below are implementation targets, not extra public packages. A hatch implementation can keep each module in one file until it earns a split.

## `client`

Owns `InspectClient`, branded public ids, receipts, `SessionView`, and stable `SessionUpdate` variants. The HTTP client translates its private wire format here. It does not export event envelopes, Durable Object values, sandbox handles, or OpenCode events.

## `session-domain`

Owns `SessionEvent`, `SessionAggregate`, `SessionCommand`, `decideSessionCommand`, and `evolveSession`. This is the only module that decides whether a transition is legal. It contains no I/O. Prompt order comes from journal revision order, and the queue projection never maintains a second ordering rule.

## `session-journal`

Owns append-only stream storage, per-session sequencing, request-key receipts, revision assignment, and event delivery. `DurableSessionJournal` maps one session stream to one Durable Object-shaped shard and SQLite transaction. `InMemorySessionJournal` has the same contract. Provider-specific storage schemas stay private.

The shard is intentionally narrow. It serializes and persists decisions but does not own sandbox or agent behavior. Snapshotted folds and request-key indexes are disposable accelerators; the event stream remains the source of truth.

## `session-application`

Owns the five user intents in `SessionsClient`. It binds an authenticated principal, resolves the current repository image, mints ids, obtains an opaque GitHub authorization grant when needed, and submits one domain command. Callers never coordinate boot, sync, queue claims, snapshots, pushes, or PR opening.

## `session-projections`

Owns rebuildable `SessionView`, `AgentInboxProjection`, sync-gate reads, PR lookup, public update mapping, and realtime cursors. UI and agent projections fold the same envelopes for different access patterns. Projection checkpoints may lag or be deleted without losing session state.

## `subscriber-runtime`

Owns at-least-once delivery checkpoints and effect execution records. `SessionEventPump` hands an envelope to one named subscriber and acknowledges it only after the handler returns. External ports also receive a deterministic `EffectId`, because a local effect ledger cannot close the crash window around a remote call by itself.

## `sandbox-lifecycle`

Owns image or resume-snapshot boot, keystroke warming, git sync, idle snapshots, sandbox stop, and branch push. `SandboxLifecycleSubscriber` reconciles these policies from session events. `SandboxPlatform` has Modal-shaped and fake adapters, but Modal SDK values do not cross the port.

The sync result is recorded in the journal. Reads are allowed as soon as `SandboxBecameAvailable` appears; writes remain blocked until `GitSyncCompleted`.

## `agent-runtime`

Owns prompt claiming, OpenCode server start or reconnect, output recording, stop, and plugin composition. `AgentRuntimeSubscriber` consumes the agent inbox projection and makes `PromptRunStarted` the durable queue claim. The OpenCode adapter converts provider events and tool hooks to domain values at its boundary.

`SyncGatePlugin` enforces read-early/write-late access. `SlackStatusToolsPlugin` records status events for Slack projections rather than calling Slack directly. `ChildSessionToolsPlugin` records a spawn request.

## `child-sessions`

Owns fan-out from `ChildSessionSpawnRequested`. It derives a child id from the request event, creates a separate child journal with the inherited repository and author, and records the link in the parent. A retry sees the same ids, so it cannot create extra children.

## `github-workflow`

Owns user authorization grants, PR opening, and webhook lifecycle translation. The sandbox module pushes the branch. Once `BranchPushed` exists, `GitHubWorkflowSubscriber` resolves the requesting user's grant and opens the PR with a provider idempotency key. `GitHubWebhookIngress` verifies unknown input, finds the session by provider PR reference, and appends a lifecycle event.

OAuth secrets live only in the authorization vault. Journal events contain the grant id and author snapshot, never a token.

## `api-ingress` and client adapters

Own authentication and parsing for web, Slack, and future clients. Each adapter converts unknown external input to a principal plus a `SessionsClient` call. Slack thread ids map to `SessionId`; they do not become session-domain types. WebSocket or SSE framing stays inside the realtime adapter.

## `local-kit`

Composes the in-memory journal, projection store, deterministic event pump, fake sandbox, fake agent, fake GitHub, and local identities. It exercises the same commands and subscribers as production. `settle()` exists for deterministic tests; normal local usage can run the pump automatically.

## Dependency direction

```text
web/slack/client adapter -> session-application -> session-domain + session-journal
query/realtime adapter   -> session-projections -> session-journal

event feed -> sandbox-lifecycle -> sandbox port + session-application
event feed -> agent-runtime     -> agent port + session-application
event feed -> child-sessions    -> session-application
event feed -> github-workflow   -> GitHub port + authorization vault

local-kit -> all ports through fake adapters
```

A command trace crosses at most the adapter, application, and journal/domain boundary. An effect trace crosses the event pump, one owning subscriber, and one provider port. No module is named after a temporal stage such as load, validate, or save.
