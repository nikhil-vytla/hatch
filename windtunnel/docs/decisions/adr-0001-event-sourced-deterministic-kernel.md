# ADR-0001 — Event-sourced deterministic kernel

**Status:** accepted · 2026-07-04

## Context

The framework must guarantee reproducible seeds, deterministic replay, hidden
state, and trajectory-level verification. Mutable-state simulators make replay and
"what did the agent actually cause?" questions archaeology. Inspect/verifiers store
message logs; neither has a world whose evolution is itself replayable.

## Decision

The world is an event-sourced state machine:

- All change enters as an **Event** (typed, timestamped in virtual time, carrying
  the id of the actor/system that caused it and the RNG stream it drew from).
- **Reducers** are the only code that mutates the entity store, in response to a
  single event, with no I/O and no unseeded randomness.
- The **Trace** (ordered event log + recorded actor decisions + final snapshot) is
  the canonical artifact. World state at any point is a fold over the log.
- Determinism contract: `replay(spec, seed, decision_stream)` produces a
  bit-identical event log. Verified by trace hashing in tests.

## Alternatives considered

- *Mutable world object with checkpoint snapshots* — simpler writes, but replay
  fidelity depends on snapshot completeness; causality is not queryable.
- *Full CQRS with projections* — over-engineered for v0; we keep one read model
  (the entity store) and add projections only if verifiers need them.

## Consequences

- Verifiers, dataset export, debugging, and replay all consume one format.
- Every stochastic draw must go through named RNG streams (ADR-0003 companion
  rule); hidden randomness becomes a code-review-visible defect.
- Cost: events are more ceremony than direct mutation. Accepted for a research
  platform where audit > write ergonomics.
