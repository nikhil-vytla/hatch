# ADR-0008 — Benchmark adapters, tools-as-data, oracle self-validation

**Status:** accepted · 2026-07-04

## Context

The platform must "adapt industry-leading benchmarks" (goal brief), not only
run home-grown worlds. ADR-0006 predicted this would be "a converter per
format"; this ADR proves and hardens that path.

## Decision

1. **Adapter protocol:** `(rows, brief) -> list[WorldSpec]`, registered like
   any plugin (`registry.adapters`). Shipped: `bfcl_style` for
   function-calling rows (question / function schemas / expected calls /
   canned responses), exercised end-to-end by `orrery adapt … --run`.
2. **Tools-as-data.** A `tool` entity whose attrs carry a canned `response`
   is a complete simulated tool — `call_tool` falls back to it when no Python
   implementation is registered. Consequence: adapted specs have `uses = []`;
   they are *pure data* (hashable, diffable, shippable) with no code package
   attached. Python tools remain available when behavior must depend on
   state or randomness.
3. **The SUT is a parameter, not part of the task.** The adapter emits the
   world (user NPC + tools + contract); the agent policy comes from the
   brief. The same adapted task runs against a scripted agent, a playbook
   model, or a live provider — that separation is what makes a benchmark a
   *reusable world* rather than a harness-specific script.
4. **Oracle self-validation.** The default agent is an oracle that performs
   exactly the task's expected actions. Oracle passes ⇒ the conversion
   faithfully encodes the task; this turns "did we port the benchmark
   correctly?" into a test, run automatically over every adapted row.

## Alternatives considered

- *Port benchmarks as Python domain packs* — maximum fidelity, unbounded
  per-benchmark effort, and the result isn't inspectable data. Kept only for
  benchmarks whose tools genuinely need stateful simulation.
- *Run benchmarks in their native harnesses and import resulting traces* —
  no world ground truth, no chaos/perturbation, no policy swapping; that's
  an importer, not an adapter, and solves a different problem.

## Consequences & accepted simplifications

- Expected-call matching is exact on args (`payload_contains`), a
  simplification of BFCL's accepted-answer ranges; a `matches_any` verifier
  param generalizes it when a full BFCL port lands (M4).
- Multi-turn, stateful benchmarks (τ-bench-style) need scripted *reactive*
  users and DB-entity initialization — both exist as primitives already;
  that adapter is the M4 deliverable.
- Dynamic worlds got first-class support in the same change: `spawn_entity`/
  `despawn_entity` mechanics let timelines and actors grow the world mid-run
  (emergent tasks), with growth flowing through the event log so replay and
  verifiers see it like any other change.
