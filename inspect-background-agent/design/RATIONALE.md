# Rationale (synthesized)

## Problem

Build a hatch-scale Inspect-style background agent from Ramp's published spec: sandboxed sessions, multi-client multiplayer, queued prompts, read-early/write-blocked git sync, user-authored PRs, warm-on-keystroke, runnable without Modal or Cloudflare. The non-obvious choice is the root aggregate. Sessions are what users see, but image lineage, warm pools, staleness, branch namespaces, and sandbox reclamation are repo-scoped and shared.

## Usage (caller's view)

See [USAGE.md](USAGE.md). Callers open a workspace, start a session, submit turns, watch events, publish a PR. Slack uses one `dispatch` call. No caller coordinates warm, sync, or snapshot.

## Shape

**Workspace-first (arena candidate 4), refined against the CTO three-plane topology.**

See [TOPOLOGY.md](TOPOLOGY.md) and [HARNESSES.md](HARNESSES.md).

- **Orchestration plane:** `Workspace` owns supply (layered images, pool, leases, branch routing). Matches Modal Session/Sandbox managers + Dict.
- **Control plane:** `Session` owns durable turns/authorship (SessionAgent DO–shaped). `EventBus` fans events to clients; `PromptIngress` accepts multiplayer enqueue while compute is cold (Modal Queue–shaped).
- **Execution plane:** `Runner` is first-class — drains prompts, talks to OpenCode, mints JWT sidecar URLs (code-server / VNC / ttyd). Agent port is only reachable through Runner.
- Write gate stays typed: `admitWrites()` → `MutableSlot`.
- Credentials: `InstallationToken` vs `UserToken`; callers pass `Actor`.
- Session mailbox serializes execution; ingress queue decouples client submit from Runner drain.
- Hatch: in-process bus/queue/runner; CF DO + Modal remain adapter swaps.

Public surface stays small: `Inspect` → `Workspace` → `Session`. Side-car URLs appear on `SessionView`, not as raw tunnel handles.

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
