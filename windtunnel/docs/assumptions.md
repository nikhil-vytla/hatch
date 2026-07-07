# Assumptions & Unknowns

Unknowns Discovery pass, run before the first line of kernel code. Each unknown
gets: the question, the options considered, what we chose (or deferred), and why.
Resolved unknowns graduate to ADRs in `decisions/`.

## U1 — Determinism vs. async agents

**Question.** LLM-backed actors are nondeterministic and slow (network I/O). How can
a run be deterministic and replayable?

**Options.** (a) Forbid nondeterminism (only scripted actors) — useless. (b) Seed the
LLM (temperature 0) — providers don't guarantee it. (c) Split the determinism
boundary: the *world* is a pure deterministic function of (spec, seed, decision
stream); actor decisions are *recorded* into the trace, and replay substitutes
recorded decisions instead of calling the actor.

**Chosen: (c).** Determinism claim becomes precise and testable: same spec + seed +
decision stream ⇒ bit-identical trace. Live runs record; replay re-derives the world
and verifies convergence. → ADR-0001.

## U2 — Time model

**Question.** Wall-clock, tick-based, or discrete-event virtual time?

**Options.** Tick-based (simple, wasteful, quantization artifacts); wall-clock
(irreproducible); discrete-event simulation (priority queue of scheduled events,
virtual clock jumps to next event).

**Chosen: discrete-event virtual time.** Long-running timelines ("30 simulated
days") cost nothing; chaos perturbations are just scheduled events; determinism is
natural. Tie-breaking must be total: order by (time, priority, sequence). → ADR-0003.

## U3 — Concurrency semantics for simultaneous actors

**Question.** When two actors act "at the same time", who wins?

**Chosen.** Simultaneity is resolved by deterministic total order (time, priority,
seq). Actions are *intents*; the world may reject an intent invalidated by an
earlier same-instant event (optimistic concurrency at the reducer). We do NOT do
speculative parallel execution in v0. **Open:** parallel *evaluation* of independent
actor policies (their I/O) while keeping ordered *application* — planned, kernel
design permits it (policies are async, application is serialized).

## U4 — State representation

**Question.** Free-form dict blackboard vs. typed entity store vs. full ECS?

**Chosen.** Typed entity store: entities are Pydantic models keyed by id, mutated
only inside reducers in response to events. Not full ECS — component/system
indirection isn't paying rent at this scale (KISS). Facts vs. observability handled
by observation policies, not by storing separate "public state". → ADR-0002/0006.

## U5 — Verifier expressiveness

**Question.** Full temporal logic (LTL/CTL) vs. ad-hoc scoring functions?

**Chosen.** LTL-lite combinators over the trace: `always`, `never`, `eventually`,
`precedes`, plus boolean/weighted composition and arbitrary Python predicates.
Verdicts carry *evidence* (event ids). Full model checking is out of scope; judges
(LLM-graded) are just another Verifier implementation and can see ground-truth
world state, not only transcripts. → ADR-0004.

## U6 — Modality-agnostic surfaces

**Question.** How do we support browsers/audio/embodiment later without designing
them now?

**Chosen.** Observations and intents are built from typed **content parts**
(text/image/audio/structured refs — mirroring modern model APIs). A `Surface`
renders world state → observation and parses raw agent output → intents. Text and
tool-call surfaces ship in v0; a browser surface is a new Surface impl, not a
kernel change. **Assumption to revisit:** content-parts are sufficient for
continuous control (robotics) — probably need a streaming surface variant later.

## U7 — Ingesting arbitrary agent SDKs

**Question.** verifiers-v1-style interception proxy is the right end-state but a
large lift. What's the v0 boundary?

**Chosen.** Three ingestion tiers: **T0** in-process `Policy` protocol (v0, ships);
**T1** adapter wrapping an SDK client object (v0-adjacent); **T2** localhost
interception proxy for unmodified agent binaries (designed-for, not built).
The kernel only ever sees `Actor.decide(observation) -> intents`, so tiers are
transport details. → ADR-0005.

## U8 — World generation from high-level descriptions

**Question.** Is the LLM world-compiler part of the kernel?

**Chosen.** No. The kernel consumes a **WorldSpec** (declarative IR: entities,
actors, timeline, perturbations, verifier contract). Generators produce WorldSpecs:
v0 ships TOML loading + a seeded procedural generator; an LLM compiler is a
generator plugin later. This keeps generation auditable — you can always read the
IR that a fancy generator emitted. → ADR-0006.

## U9 — Snapshots

Event log is the source of truth; periodic state snapshots are a pure optimization
for long timelines. v0: snapshot at end only. No architectural impact.

## U10 — What we are explicitly NOT building in v0

- RL training integration (trace format is designed to export to it).
- Distributed execution / sandboxed runtimes (Runtime protocol reserved).
- The interception proxy (T2).
- LLM-backed generation and judging (protocol slots exist; deterministic
  implementations ship so tests never need network).

## Standing assumptions

1. Python 3.12+, single-process asyncio in v0.
2. Trace files are JSONL; size acceptable for v0 scenario lengths (<10^5 events).
3. Verifiers run post-hoc over the trace in v0; online (streaming) verification is
   a planned optimization with the same interface.
4. Root seed + spec hash + package version are sufficient citation for
   reproducibility (Bloom-style "cite the seed").
