# Self-check against design-red-flags.md

## Shallow module

**Screened.** Public surface is small per handle (`enqueue`/`stop`/`queue`, `hintWarm`/`gate`/`phase`/`ideUrl`, `subscribe`, `open`, `child`/`status`, `apply`). Warm/sync/snapshot/drain/OpenCode stay behind those methods; callers do not assemble a pipeline.

**Residual risk:** `SandboxHandle` could slide into a shallow lifecycle API if we later add `awaitSync()` / `snapshotNow()`. Sketch forbids that — observation + hint only. `SpawnHandle.status` returning `{ phase, queue }` is slightly wide but avoids a second god-object for child polling.

## Information leakage

**Screened.** Modal, Durable Objects, OpenCode, Slack Block Kit, and GitHub webhook wire payloads are confined to adapters. Public stream is `SessionEvent`. User tokens parse at `PullRequestHandle.open`; interior uses `UserGithubToken`.

**Residual risk:** `SessionActorPort.bindSandbox({ sandboxId: string })` uses a string sandbox id on the port boundary — acceptable as port-internal, must not appear on public handles (it does not). Grant token format must stay factory-private so clients cannot forge kinds.

## Temporal decomposition

**Screened.** Modules are factory/handles, actor, sandbox, agent, github, clients — ownership of invariants, not boot→sync→prompt→PR folders. Prompt drain runs at a different time than mint but lives with the actor + factory, not a `stages/runPrompt.ts` module.

**Residual risk:** A future “orchestrator” package that sequences acquire→start→enqueue would reintroduce temporal decomposition; factory mint should remain the only sequencer for boot wiring.

## Pass-through method

**Screened.** Handle methods add policy: authorship on enqueue, token parse on PR open, coalesce semantics on `hintWarm`, idempotent `stop`/`apply`. `EventCursor.subscribe` → `actor.readEvents` is intentionally thin (adaptation boundary for grants/WS); acceptable as capability check + projection, not a second business layer.

**Honest finding:** `LifecycleHandle.apply` is nearly a pass-through to `actor.applyLifecycle`. Kept only to enforce capability attenuation (webhooks cannot enqueue). If lifecycle stays this thin, do not add further wrapper layers.

## Axis fidelity (C)

Public API is capability objects minted by a factory; no god-session facade. Private actor exists for per-session serialization — that is implementation, not the caller shape. Distinct from axis A (Session-as-actor public API).

## Rubric touch

1. USAGE: multi-client mint → prompt → stream → PR; no Modal/DO/OpenCode wire types.  
2. Types: phase, authorship, sync gate, queue as unions/brands.  
3. Modules by ownership.  
4. Callers do not coordinate warm/sync/snapshot.  
5. `memoryAdapters` / fake ports for hatch.  
6. This file documents red-flag screening with residuals.
