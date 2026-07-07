# Research — prior art and what we take from it

Grounding pass run 2026-07-04 against primary sources (project docs/READMEs plus
prior knowledge of the codebases). This is not a survey; it is a extraction of
load-bearing ideas and their limits, to inform Windtunnel's abstractions.

## Snowglobe (Guardrails AI)

**What it is.** A hosted simulation engine that generates thousands of synthetic
conversations to stress-test chatbots pre-deployment. Core concepts: **Personas**
(synthetic users with goals/personality), **Scenarios** (individual simulated
conversations), **Simulations** (a full test run), **Metrics**.

**Take:** persona-driven generation of *populations* of interactions, and the
risk-feedback loop — results re-prioritize which personas get explored next.
Simulation as QA-at-release-speed is the product framing to preserve.

**Limits:** conversation-shaped only (one chatbot, one synthetic user, text turns);
the "world" is implicit in the persona prompt, so there is no shared environment
state, no hidden state, no multi-agent topology, and evaluation is judge-over-text.

## Prime Intellect `verifiers` (v1)

**What it is.** An RL environment library. v1 decomposes into three independently
swappable parts: **Taskset** (data + scoring + lifecycle hooks), **Harness** (the
program driving the model turn-by-turn), **Runtime** (subprocess/Docker/remote
sandbox), coordinated by an `Environment` into `Episodes` → `Rollouts`.

**Load-bearing ideas:**
- **Interception architecture**: the harness points its *native* model SDK at a
  localhost endpoint; the framework sits behind it. Budget enforcement, user
  simulation, and recording are invisible to harness code. This is how you ingest
  "arbitrary agent SDKs" without adapters per SDK.
- **Trace as message graph**: messages stored once as linked nodes; branching is
  first-class; identical prefixes collapse by hash. Every root-to-leaf path is a
  trainable sample. Avoids quadratic conversation storage.
- **Token invariant**: concatenated node token IDs reproduce exactly what the model
  saw — protects training-data fidelity against renderer retokenization.
- **Error attribution boundaries**: every failure maps to provider / harness /
  sandbox / taskset, so traces record root causes.

**Limits:** environment = dataset + reward around a *single* model harness; the
world model is thin (no shared world state, virtual time, or perturbation model);
multi-agent is not the organizing principle.

## Inspect AI (UK AISI)

**What it is.** Eval framework: **Task = Dataset + Solver + Scorer**, with sandboxes,
tool use, agent support, and rich eval logs; 200+ prebuilt evals; extensions ship as
Python packages (plugin philosophy).

**Take:** the log as the canonical, analyzable artifact; composable solvers;
registry/plugin extension model; sandbox abstraction separated from eval logic.

**Limits:** dataset-of-samples framing. Each sample is an independent short episode;
there is no persistent world, timeline, or cross-episode state. Scoring attaches to
samples, not to trajectories over a shared world.

## Petri / Petri Bloom (Anthropic / Meridian)

**What it is.** Automated behavioral auditing: an **auditor** agent probes a
**target** model inside simulated tools/environments; **Bloom** grows a test suite
from a **seed configuration** (behavior spec → diverse generated scenarios →
conversations → multi-dimensional judge scores). Evaluations are cited *with their
seed* for reproducibility.

**Take:** adversarial probing as an *agent role*, not a scoring pass; generated
(not hand-written) scenario populations; "cite the seed" reproducibility; scoring
across named behavioral dimensions.

**Limits:** the environment is simulated ad hoc by the auditor (tools are faked in
context), so there is no ground-truth world state to verify against — judges can
only read the transcript.

## Chaos engineering (Netflix lineage)

**Take:** perturbations are *scheduled, hypothesis-driven experiments* against a
steady-state definition — not random noise. Faults (tool outage, latency, corrupted
data, actor misbehavior) should be first-class timeline events with seeds, blast
radius, and an expected-invariant to verify. "Steady state" maps directly to
always-invariant verifiers.

## Synthesis → what Windtunnel must do differently

1. **A real world model.** All four systems evaluate *conversations or episodes*;
   none has shared, hidden, evolving world state. Windtunnel's core is an event-sourced
   world with partial observability per actor. Judges get ground truth, not just
   transcripts (fixes Petri's blind spot).
2. **Everything is an actor.** Agent-under-test, synthetic users (Snowglobe
   personas), auditors (Petri), chaos daemons — one scheduling abstraction.
   Multi-agent stops being a feature and becomes the default topology.
3. **One canonical artifact.** A single Trace format (event log + state snapshots)
   consumed by replay, verifiers, dataset export, and debugging — merging Inspect's
   eval log with verifiers' message graph, extended to world events.
4. **Interception for SDK ingestion** (from verifiers v1): agents connect through
   surfaces/proxies; the framework observes without requiring the agent to know.
5. **Seeded everything** (from Bloom + chaos): world generation, stochasticity,
   perturbation schedules, NPC behavior — all derive from named RNG streams under
   one root seed. A run is citable as (spec, seed, code version).
6. **Verifier-first, contract-first worlds**: a world spec co-declares its
   invariants (always/never) and objectives (eventually), so generation and
   evaluation share one contract — brittle per-sample scoring disappears.
