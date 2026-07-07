# ADR-0002 — Everything is an actor

**Status:** accepted · 2026-07-04

## Context

The brief demands multi-agent simulation as first-class, plus synthetic users
(Snowglobe personas), adversarial auditors (Petri), and chaos injection. Prior art
treats each as a separate feature bolted onto a single-agent loop.

## Decision

One abstraction: an **Actor** = identity + `Policy` (async
`decide(observation) -> intents`) + `Surface` binding + RNG stream. The
agent-under-test, NPC users, adversarial probes, and chaos daemons are all actors
scheduled by the same discrete-event kernel. "Multi-agent" is therefore not a mode;
a single-agent eval is just a world with one interesting actor.

Chaos daemons are actors whose intents are perturbations (tool outage, latency,
corruption) — giving chaos experiments identity, seeds, scheduling, and trace
attribution for free.

## Alternatives considered

- *Agent vs. environment dichotomy (Gym-style `step()`)* — collapses under
  multi-agent and under "the user simulator is also a model".
- *Special-cased chaos injector subsystem* — duplicate scheduling and attribution
  machinery; rejected.

## Consequences

- Uniform trace attribution: every event has a causing actor.
- Roles (`system_under_test`, `population`, `adversary`, `chaos`) become metadata
  used by verifiers and reporting, not by the kernel.
- Risk: over-generalization. Mitigated by keeping Policy the only required method.
