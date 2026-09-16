# Rationale — candidate 3

## Problem

We need a hatch-scale Inspect-style background agent: per-session actor state, sandbox snapshots with a read-early/write-blocked sync gate, queued prompts with stop, multiplayer authorship, OpenCode-shaped runtime plugins, multi-client realtime events, and user-token PR open — runnable with fake adapters. The non-obvious part is the public API shape: a single Session facade tends to accumulate warm/sync/snapshot/queue/PR/spawn methods and leak lifecycle coordination to callers, while still needing attenuation for Slack vs web vs webhooks vs agent plugins.

## Usage (caller's view)

Callers import `createInspect` and receive a `SessionCapabilities` bundle of narrow handles — never a god-session. Typical flow: `mint` → `sandbox.hintWarm` → `prompt.enqueue` → `events.subscribe` → `pullRequest.open` with a user GitHub token. Multiplayer is `rehydrate(sessionId, author)` yielding an authorship-bound `PromptHandle`. Slack and web hold grant tokens reconstituted via `*FromGrant`; webhooks use `lifecycleFor` only; the agent plugin receives `SpawnHandle`, not the full bundle. See `USAGE.md` for the three call sites. The type sketch in `SKETCH.ts` is derived from that usage.

## Shape

**Structural axis: C — Capability-token session.**

Load-bearing decisions:

1. **Factory mints capabilities, not a Session object.** `InspectFactory.mint/rehydrate` returns `{ sessionId, prompt, sandbox, events, pullRequest, spawn }`. Each handle carries an opaque `CapabilitySecret` and exposes only its job. There is no public class with enqueue + warm + snapshot + openPR + spawn together. Per `interface depth`: complexity of actor drain, Modal boot, sync, and OpenCode plugins sits behind small methods.

2. **Data structures first.** Branded ids (`SessionId`, `PromptId`, `GrantToken`, …). `SyncGate` and `SessionPhase` as discriminated unions so write-blocking and lifecycle are not string flags. `PromptQueueEntry` states encode queue-not-interrupt policy. `SessionEvent` is the only realtime vocabulary clients see.

3. **Authorship at the handle boundary.** `PromptHandle` is bound to an `Author` at mint/rehydrate; enqueue always attributes that author. Session actor stores a set of authors — never a single owner. Per `encode-lessons-in-structure` and `separate-before-serializing-shared-state`: writers are per-author enqueues; merge is the shared queue/event log inside one actor.

4. **SandboxHandle is observation + hint, not a lifecycle driver.** `hintWarm` is coalesced and fire-and-forget; `gate`/`phase`/`ideUrl` are reads. Sync completion and resume snapshots are owned by sandbox port + actor callbacks. Callers do not order boot → sync → run.

5. **Validation at boundaries.** `parseUserGithubToken` and webhook verification live at handle/adapter edges; interior actor methods trust domain types (`boundary-discipline`).

6. **Idempotent transitions.** `stop`, `hintWarm`, lifecycle `apply`, and branch push / PR open are specified as safe under retry (`make-operations-idempotent`).

7. **Ports for hatch.** `memoryAdapters()` satisfies every port; Modal/DO/OpenCode are adapter substitutions without changing handles.

Interface depth: the public surface is roughly six handle types + factory entry points. Hidden behind it: image selection, warm pool/keystroke coalesce, sync gate plugin, prompt drain, snapshot-on-exit, Agents-SDK/WS hibernation, git user rewrite on push. Exposed to callers: what to say, whom to attribute, when to stop, when to open a PR, and how to subscribe — the decisions only a human/client can make.

Deliberately omitted from the public surface: Chrome MDM, voice, full Ramp MCP suite (extension via `AgentRuntimePort` plugins).

## Synthesis decision

N/A — candidate sketch

## Tradeoffs accepted

- We accept **more objects per session** (capability bundle) in exchange for **no god-session and natural attenuation** (webhook gets lifecycle only; agent gets spawn only).
- We accept a **private session actor** that still centralizes queue/stream state in exchange for a **public API that does not expose that actor** — judges may mistake this for axis A; the distinction is the caller-visible shape, not the absence of an actor.
- We accept **grant-token reconstitution** (`*FromGrant`) in exchange for **browser/Slack not holding live handle instances** across processes.
- We accept **PR open on a capability rather than automatic PR on push** in exchange for **explicit user-token presentation** at the decision boundary (avoids silent app-identity PRs).
- We accept **SpawnHandle.child → factory.mint** as a thin cycle in exchange for **one mint path** for parent and child sessions (no duplicate create pipeline).

## Alternatives considered

- **Session-as-actor facade (axis A):** one long-lived `Session` with all methods. Hides runtime complexity but **exposes a wide surface**; every client sees spawn/PR/lifecycle together, inviting misuse. Lost on attenuation and shallow-module risk — callers learn a large API that still requires knowing which methods apply when.
- **Event-sourced log as public API (axis B):** clients append commands, subscribe to projections. Deep for audit/multiplayer, but **pushes coordination of warm/PR into command vocabulary** or sagas the caller must understand. Lost for hatch interface depth: simple enqueue/stream/PR becomes event choreography.
- **Workspace-first (axis D):** Workspace aggregate owns pools/images; Session is a lease. Strong for warm pools, but **elevates infra to the root** and makes multiplayer authorship and prompt queue secondary. Lost because the product primary is the collaborative session, not the pool.

## Open questions and risks

- Should `GrantToken` be macaroon-style (attenuable caveats) or opaque server-side session secrets with a lookup table?
- When `rehydrate` races with sandbox suspend, does `hintWarm` always resume-from-snapshot, or do we mint a fresh sandbox and rely on the actor to pick `resumeFrom`?
- Is `PullRequestHandle.open` allowed for any author who rehydrated, or only authors who can present their own GitHub token (and should that be typed as `Author`-bound PR handles)?
- How should child sessions inherit GitHub auth — founder only, or the parent prompt’s author?

## Next implementation step

Implement `memoryAdapters()` + `InspectFactoryImpl.mint/rehydrate` so the USAGE.md quickstart runs end-to-end with a fake sandbox that flips `SyncGate` to ready and an agent stub that emits `agent.token` events.
