# Rationale (synthesized)

## Problem

Build a hatch-scale Inspect-style background agent from Ramp's published spec: sandboxed sessions, multi-client multiplayer, queued prompts, read-early/write-blocked git sync, user-authored PRs, warm-on-keystroke, runnable without Modal or Cloudflare. The non-obvious choice is the root aggregate. Sessions are what users see, but image lineage, warm pools, staleness, branch namespaces, and sandbox reclamation are repo-scoped and shared.

## Usage (caller's view)

See [USAGE.md](USAGE.md). Callers open a workspace, start a session, submit turns, watch events, publish a PR. Slack uses one `dispatch` call. No caller coordinates warm, sync, or snapshot.

## Shape

**Workspace-first (arena candidate 4), with grafts.**

- `Workspace` owns supply (images, pool, leases, branch routing). `Session` owns conversation (queue, roster, transcript) and holds a fenced slot lease.
- Write gate is typed: `LeasedSlot` is read-only; `admitWrites()` yields `MutableSlot`. OpenCode's sync plugin awaits admit rather than polling a flag.
- Credentials: `InstallationToken` for clone/push, `UserToken` for PR open; callers pass `Actor`, never tokens.
- Session mutations serialize through a command mailbox (graft from candidate 1) with pure transition helpers.
- Provider calls carry `EffectId` for at-least-once retries (graft from candidate 2).
- Agent plugins get attenuated `TurnCapabilities` including `childStatus` (graft from C3/C1). Browser streams may use a read-only grant (graft from C3).
- Hatch: workspace + session run in-process with local fencing; Durable Object / Modal are adapter swaps.

Interface depth: Workspace (~6 methods) + Session (~7) hide pool, sync, resume, and publish sequencing. Exposed decisions are repo, speaker, prompt text, and whether to open a PR.

## Synthesis decision

Base: **candidate 4**. Parent initially preferred candidate 1 for hatch simplicity; cross-judge preferred 4 for typed gates and repo-scoped ownership. Resolved for 4 because retrofitting `admitWrites` and a real workspace aggregate into a session-rooted design is the expensive migration, while hatch can simplify leasing to in-process fencing without changing the public shape. Grafts: C1 mailbox + childStatus; C2 EffectId + EventOrigin; C3 read grants + ideUrl. Rejected: C2 journal-as-gate-authority, C3 raw token strings on public PR open, C1 polling gate.

## Tradeoffs accepted

- We accept Workspace as required for every session in exchange for one home for supply and reclamation.
- We accept in-process lease fencing at hatch scale in exchange for shipping the shape without multi-DO protocol risk.
- We accept `admitWrites` parking tool calls during sync in exchange for TTFT bounded by the model, not the clone.
- We accept publishing `Freshness` on the event stream in exchange for clients explaining parked turns.

## Alternatives considered

- **Session-as-actor root (C1):** smaller surface, but SandboxFleet becomes an informal workspace without a reaper or population view. Lost on retrofit cost for pool/reclaim.
- **Event-sourced journal as truth (C2):** strong audit, weak synchronous gate. Lost for write permission answered from a projection.
- **Capability tokens as public API (C3):** good attenuation, shallow handles over a wide setter port, callers assemble more. Kept attenuation inside the agent boundary only.

## Open questions and risks

- When should a parked session cold-boot vs resume a snapshot whose image generation expired?
- Should any participant publish, or only the opener?
- How large may the event log grow before chunking agent deltas to blob storage?

## Next implementation step

Implement pure `nextFreshness` / `advanceQueue` / `branchOfSession`, local `ComputePort` with configurable sync delay, and a session mailbox that parks mutating tools until `admitWrites` resolves.
