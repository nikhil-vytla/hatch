# Candidate 2 design package

This package proposes an Inspect-style background agent built around one append-only event journal per session. The journal is the source of truth. UI, agent, sync-gate, child-session, and GitHub views are rebuildable projections, while sandbox and agent runtimes consume events as at-least-once subscribers.

## Package contents

- [`USAGE.md`](USAGE.md) defines the caller contract with local, web multiplayer, and Slack call sites.
- [`SKETCH.ts`](SKETCH.ts) derives branded ids, discriminated unions, commands, events, projections, ports, subscribers, and fake adapters from that contract.
- [`MODULES.md`](MODULES.md) assigns policy and data ownership without splitting modules by execution stage.
- [`RATIONALE.md`](RATIONALE.md) records the event-sourced choice, tradeoffs, alternatives, risks, and first implementation step.
- [`SELF_CHECK.md`](SELF_CHECK.md) screens the shape for shallow interfaces, leakage, temporal decomposition, and pass-through methods.
- [`NOTES.md`](NOTES.md) records the work and checks performed.

## Core decision

Every accepted intent appends immutable session facts through a per-session sequencer. Concurrent authors cannot overwrite shared state, and journal revision order defines prompt queue order. Subscribers record durable claims before remote work and pass deterministic effect ids to sandbox, agent, and GitHub adapters.

The public API exposes create, draft activity, prompt, stop, PR request, query, and watch operations. It does not expose Durable Object, Modal, OpenCode, Slack, or GitHub wire values. A local composition uses the same domain and subscriber paths with in-memory and fake adapters.

## Verification

`SKETCH.ts` passes TypeScript strict checking with the latest compiler:

```sh
npx --yes --package typescript@latest tsc \
  --noEmit --strict --target ES2022 --lib ES2022,DOM \
  arena/candidate-2/SKETCH.ts
```
