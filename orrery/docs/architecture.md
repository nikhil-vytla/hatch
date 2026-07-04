# Orrery Architecture

*Current as of v0. See `decisions/` for why each piece is shaped this way.*

## One-paragraph model

An Orrery run executes a **WorldSpec** (declarative IR) on a deterministic
**kernel**: a discrete-event scheduler activates **actors** (agent-under-test,
NPC personas, adversaries, chaos daemons — all the same abstraction), each of
which perceives the world through a **surface** filtered by its **observation
policy**, and acts by submitting **intents**; **mechanics** validate intents and
emit **events**; **reducers** fold events into the entity store. Everything that
happens is appended to a **trace** — the single canonical artifact — over which
composable **verifiers** (LTL-lite predicates with evidence-carrying verdicts)
check the world's declared **contract**. All randomness flows from named streams
under one root seed, so a run is citable as (spec hash, seed, version) and
replayable bit-for-bit.

## Diagram

```
                 ┌────────────────────────────────────────────────┐
   brief/seed →  │ Generators (TOML load · procedural · LLM later)│
                 └───────────────────────┬────────────────────────┘
                                         ▼
                              WorldSpec (IR, hashable)
                    entities · actors · timeline · contract
                                         ▼
 ┌───────────────────────────── KERNEL (engine.py) ─────────────────────────────┐
 │                                                                              │
 │   Scheduler (virtual time, total order)      RngRegistry (named streams)     │
 │        │ activations & scheduled events           │ per-actor / per-system   │
 │        ▼                                          ▼                          │
 │   ┌─────────┐  observation  ┌────────┐  intents  ┌──────────┐  events        │
 │   │ Surface │ ◄──────────── │ Actor  │ ────────► │ Mechanics│ ──────┐        │
 │   │ +ObsPol │               │ Policy │           │ (validate│       │        │
 │   └─────────┘               └────────┘           │  & emit) │       │        │
 │        ▲                     ▲  ▲  ▲             └──────────┘       │        │
 │        │      same protocol for│agent-under-test, NPCs,             ▼        │
 │        │      adversaries, chaos daemons                   Reducers → World  │
 │        │                                                   (entity store)    │
 │        └────────────────────── render from ─────────────────────┘            │
 │                                                                              │
 │   every decision + event appended to ──►  TRACE (JSONL, hash-chained)        │
 └──────────────────────────────────────────────────┬───────────────────────────┘
                                                    ▼
                     ┌───────────────────────────────────────────┐
                     │ Verifiers: contract check (always/never/  │
                     │ eventually/precedes · boolean/weighted ·  │
                     │ judges-with-ground-truth) → Verdicts      │
                     │ with evidence (event ids)                 │
                     └───────────────┬───────────────────────────┘
                                     ▼
              replay (bit-identical) · reports · dataset export · QA gates
```

## Module map (`src/orrery/`)

| Module | Responsibility |
|---|---|
| `ids.py` | Typed ids, monotonic sequence counter (total order tie-breaker) |
| `rng.py` | `RngRegistry`: named, independent, seeded streams (ADR-0003) |
| `content.py` | Multimodal content parts for observations/intents (ADR-0005) |
| `events.py` | `Event` model; canonical serialization + hash chaining |
| `entities.py` | `Entity` + `EntityStore` (typed state; visibility metadata) |
| `world.py` | `World`: store + mechanics + reducers; `submit(intent)` → events |
| `clock.py` | Virtual clock + discrete-event `Scheduler` (ADR-0003) |
| `observe.py` | `ObservationPolicy` → `WorldView` (hidden state enforcement) |
| `surfaces.py` | `Surface` protocol; `TextSurface`, `ToolSurface` |
| `actors.py` | `Actor`, `Policy` protocol, roles; scripted/state-machine policies |
| `perturb.py` | Chaos mechanics: outage, latency, corruption + restore |
| `trace.py` | `Trace`, JSONL writer/reader, trace hash, decision recording |
| `verify.py` | `Verifier`, `Verdict` (+evidence), boolean/temporal combinators |
| `spec.py` | `WorldSpec` Pydantic models; TOML load; spec hash; contract |
| `generate.py` | `Generator` protocol; `ProceduralGenerator` (seeded sampling) |
| `models.py` | Provider integration: `ModelClient` protocol, `ModelPolicy`, Anthropic/playbook clients (ADR-0007) |
| `adapters.py` | Benchmark ingestion: `(rows, brief) -> [WorldSpec]`; `bfcl_style` reference adapter (ADR-0008) |
| `engine.py` | Run loop: activate → decide → submit → reduce → trace; replay |
| `plugins.py` | Entry-point discovery for policies/mechanics/verifiers/surfaces |
| `logging.py` | Structured (JSON) logging setup |
| `cli.py` | `orrery run · replay · verify` |

## Key flows

**Live run.** `engine.run(spec, seed)`: build world from spec → seed streams →
schedule timeline entries + initial activations → loop: pop next activation in
`(time, priority, seq)` order; if scheduled world event, apply; if actor
activation, render observation (through the actor's observation policy), await
`policy.decide`, record the decision, convert intents via mechanics into events,
reduce, append to trace, and let reaction rules schedule follow-up activations
(e.g., "message to X ⇒ activate X at t+δ"). Ends at horizon or quiescence.
Verifiers then evaluate the contract over the trace.

**Replay.** Same as live, but `decide` is replaced by the recorded decision
stream. The determinism contract (ADR-0001) requires the resulting event log to
hash-match the original. This is enforced in CI by property tests.

**Chaos.** A chaos daemon actor's policy draws from its own stream to pick
perturbation windows; its intents route through `perturb.*` mechanics that flip
entity state (e.g., `tool:billing.status=down`). Tools consult that state, so
faults propagate through ordinary world rules — and the trace attributes every
fault to the daemon.

**Population QA (Snowglobe-style).** Sample N seeds → `ProceduralGenerator`
varies personas/timelines → N runs → aggregate verdicts; failing traces are
replayable repro cases. Dataset export = filter traces by contract, emit
(observation, decision) pairs.

## Determinism boundary

The world is a pure function of (spec, seed, decision stream). Live actor
policies may do I/O (LLM calls); their outputs are *recorded*, and every other
source of change (mechanics, reducers, schedules, NPC draws) is seeded. See
`assumptions.md` U1.
