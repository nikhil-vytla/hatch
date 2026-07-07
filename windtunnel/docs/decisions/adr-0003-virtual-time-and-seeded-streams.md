# ADR-0003 — Discrete-event virtual time + named RNG streams

**Status:** accepted · 2026-07-04

## Context

Long-running timelines (days/months of simulated time), scheduled perturbations,
and reproducibility rule out wall-clock time and ambient `random`.

## Decision

1. **Virtual time.** A discrete-event scheduler holds a priority queue of pending
   activations keyed by `(virtual_time, priority, sequence)` — a total order, so
   simultaneity is deterministic. The clock jumps; nothing sleeps. Wall-clock cost
   is proportional to events, not simulated duration.
2. **Named RNG streams.** One root seed; every subsystem/actor derives an
   independent child stream via `numpy.random.Philox`-style spawn keys (implemented
   with `random.Random(hash(root_seed, name))` semantics in v0, stdlib-only).
   Streams are requested by name (`rng.stream("actor:customer-1")`), recorded in
   the trace, and never shared. Adding an actor cannot shift another actor's draws.

## Alternatives considered

- *Tick-based loop* — O(simulated time), quantization artifacts.
- *Single shared RNG* — insertion-order coupling: any new draw perturbs every
  later draw, destroying seed citability across code changes.

## Consequences

- Perturbation schedules, NPC behavior, and generation all derive from
  (root_seed, stream name) — a run is citable as (spec hash, seed, version).
- Policies must not use ambient randomness; the kernel hands each actor its
  stream. Enforced by convention + property tests (same seed ⇒ same trace hash).
