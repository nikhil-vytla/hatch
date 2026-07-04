# ADR-0005 — Surfaces, observation policies, and SDK ingestion tiers

**Status:** accepted · 2026-07-04

## Context

Agents must interact through text, tools/APIs today; browsers, desktops, audio,
embodiment tomorrow. Worlds need hidden state (per-actor partial observability).
Arbitrary agent SDKs should be testable without rewriting them (verifiers v1
proved interception works).

## Decision

1. **Content parts.** Observations and intents are composed of typed parts
   (`text`, `image`, `audio`, `structured`, `ref`) mirroring modern model APIs.
   New modalities extend the part union, not the kernel.
2. **ObservationPolicy.** Per-actor filter deciding which entities/attributes/events
   an actor can perceive. Hidden state = state outside your policy. The judge's
   view and the agent's view are different policies over the same world.
3. **Surface.** Binds an actor to the world: `render(world_view) -> Observation`
   and `interpret(raw_action) -> intents`. A browser surface, a voice surface, and
   a tool-API surface are peer implementations of one protocol.
4. **Ingestion tiers** for the system-under-test:
   - **T0 (v0):** in-process `Policy` protocol — write ~10 lines to wrap your agent.
   - **T1 (v0-adjacent):** adapters for common SDK client objects.
   - **T2 (designed, deferred):** localhost interception proxy speaking provider
     dialects, so unmodified agent binaries run against simulated worlds — the
     verifiers-v1 move, generalized to tool endpoints as attack surfaces.

## Alternatives considered

- *Gym-style flat observation vectors* — hostile to multimodal and to hidden state.
- *Adapter-per-SDK as the primary story* — unbounded maintenance; interception
  scales better, adapters remain as conveniences.

## Consequences

- The kernel never learns about modalities; surfaces are plugins.
- Partial observability is enforced at render time, so "the agent saw X" is a
  provable trace statement — critical for safety claims about deception or
  information leakage.
