# Design red-flag check

## Shallow modules

`SessionsClient` is small relative to what it hides. Its five intents, query, and stream cover warming, boot, sync, queue claims, stop, snapshots, push, PR auth, and retries. `noteDraftActivity` is the weakest method because its immediate purpose is warming, but naming it as user activity keeps sandbox policy out of the caller. `IdempotencyKey` and `SessionCursor` are deliberate public costs for safe retries and stream resume.

The provider ports expose several operations. They are internal ports, not caller workflows. Their subscribers add policy and durable ordering, so they are not public control panels.

## Information leakage

Public updates are mapped from events and are not event envelopes. Modal, Cloudflare, OpenCode, Slack, GitHub webhook, and OAuth token representations stop at adapters. `SyncGateView` appears in UI and agent projections because read-early/write-late is a product invariant, not a provider detail. In a real file split, `SessionEvent`, `SessionCommand`, and provider ids would be package-private; they are exported in `SKETCH.ts` only so this standalone design can show boundaries.

The main residual risk is event-schema coupling. Every projection must handle new event variants. Exhaustive reducers and versioned upcasters should keep that change in `session-domain` and `session-projections`.

## Temporal decomposition

Modules follow owners. Sandbox lifecycle owns boot, sync, snapshot, stop, and push even though they happen at different times. Agent runtime owns claim, output, plugins, and stop. GitHub workflow owns authorization, open, and webhook changes. There are no modules split into load, validate, transform, or save stages.

## Pass-through methods

`SessionCommandService.execute` resembles a forwarding method, but it folds history, runs the pure decider under the journal sequencer, converts rejections, and returns the idempotent commit. Subscribers call it because bypassing those rules would corrupt the log. Client and webhook adapters also add authentication, validation, author binding, or protocol translation before calling it.

No other wrapper repeats a provider signature. The main traces stay short: adapter to application to journal/domain for commands, and event pump to owning subscriber to provider for effects.

## Honest remaining concerns

- One session stream serializes all writes. A session producing large output chunks could delay prompt or stop commands unless output is batched or moved behind referenced blobs.
- Exactly-once remote effects are impossible with only a local ledger. Correctness depends on every provider adapter using `EffectId` as an idempotency key or reconciling provider state on retry.
- `SessionEvent` and `SessionCommand` are already broad. If unrelated product features accumulate there, splitting child-session or PR facts into linked streams may become necessary.
