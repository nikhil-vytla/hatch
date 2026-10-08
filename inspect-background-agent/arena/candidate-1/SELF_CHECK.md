# Self-check — candidate 1 vs. design-red-flags.md

## Shallow module

- `SessionActor` / `SessionHandle`: deep. Eight public methods hide queue pumping,
  gate mirroring, revive-from-snapshot, stop semantics, attribution, and token
  exchange. Learning the interface genuinely spares the caller the implementation.
- `SandboxFleet`: deep. Two entry points hide the image registry, warm pool, snapshot
  boot, and sync kickoff.
- **Finding:** `hub` is the thinnest module. `create`/`get`/`routeWebhook` add real
  policy (idempotency, actor lifecycle, branch-derived routing), but `warmHint` is
  today one line over `fleet.warm`. Kept because clients must not hold a fleet
  reference and the hub is where auth/rate limits will attach; if that never
  materializes, it is a pass-through and should be re-judged at synthesis.

## Information leakage

- Wire types (OpenCode deltas, Modal handles, octokit payloads, Slack event JSON) are
  confined to adapters; ports speak domain types only. Webhooks are
  signature-verified and parsed inside `github` before the hub sees them.
- Gate truth lives in one place (`LiveSandbox.gate()`); the actor mirrors it as
  events, and the write-block plugin reads it via a capability — one decision, one
  owner, two readers.
- **Finding:** the public `SessionView` and `phase.changed` event expose the internal
  `SessionPhase` shape, including `SandboxRef` and `SnapshotId`. Both are opaque
  brands, so nothing actionable leaks, but clients can now depend on the phase
  structure; a stricter design would project a client-facing phase enum. Flagged for
  synthesis rather than fixed, because the projection would today be an identical
  shape (temporal-decomposition-by-another-name).

## Temporal decomposition

- Modules group by owned knowledge (session-ness, sandbox mechanics, GitHub protocol,
  Slack transport), not by boot→sync→run→snapshot stages. The lifecycle steps that do
  run at different times (`ensureLive`, `pump`, `hibernate`) are private methods of
  the one module that protects those decisions, which the red-flags doc explicitly
  allows.
- No load/validate/transform/save layering anywhere; validation happens once at each
  boundary (webhook parse, Slack event parse, HTTP parse) and types are trusted
  inside.

## Pass-through method

- `SessionHandle` methods forward to the actor mailbox with the same shapes.
  Not judged a pass-through: the handle is a location-transparency + serialization
  boundary (in-process vs. DO stub), which is adaptation, not layering.
- **Finding:** `WebRoutes` as typed looks one-to-one with hub/handle methods. In
  implementation it owns HTTP parsing, auth, and status mapping, but the sketch's
  framework-neutral signatures hide that and make it look like forwarding. If the
  implementation ends up as thin as the type, fold it into the server file rather
  than keeping a module.
- `ChildSpawner.spawn` forwards to `hub.create` with the same args. Kept: it exists
  to break the actor→hub dependency cycle and to be a narrowing point (a child-spawn
  policy like depth limits belongs there), but it is honestly borderline today.

## Runner-discipline spot checks

- Usage written first; sketch reconciled to it (stop-pauses-queue and `resumeQueue`
  came out of writing the web call site, not the types).
- Dominant access patterns traced: next-prompt (array head), reconnect (`since` on a
  seq-indexed log), webhook→session (pure derivation), thread→session (adapter KV) —
  none require a later bolt-on index.
- Idempotency: `create`, `enqueue`, `ensurePullRequest`, `hibernate`, `stop` all
  survive retry/crash-halfway; noted inline in the sketch.
- Call-chain depth: client → hub → actor → port is three files to trace any flow.
