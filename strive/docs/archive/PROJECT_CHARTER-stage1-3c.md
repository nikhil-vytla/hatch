# strive — Project Charter

> **vNext thesis (supersedes the promotion-centric charter below).** Strive
> provides **Exo-like durable mechanisms for model-led adaptation**: one
> revision-native event/artifact substrate and a resumable policy command
> boundary that let a policy **apply, observe, checkpoint, and revert exact
> composite changes** to allowlisted surfaces. **Comparative evaluation is an
> optional mechanism a policy may request — not a universal activation
> prerequisite.** The earlier thesis ("every change requires empirical
> promotion") is retired: an `AcceptancePolicy` gate no longer stands between
> a policy and a change. What remains non-configurable is the FLOOR (below),
> not any particular adaptation ceremony.
>
> **The non-configurable floor.** Regardless of policy: allowlisted surfaces;
> exact before/after state (content-addressed); expected-head conflict
> checks; CAS integrity; append-only, tamper-evident effects;
> checkpoints/rollback and crash recovery; budgets; the sandbox / secret /
> permission boundaries; and explicit controls around irreversible effects.
> Comparative evaluation, held-out discipline, statistical acceptance, and
> Pareto retention are all *mechanisms a policy may compose*, never a gate
> the kernel imposes.
>
> See `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, and
> `docs/adrs/0008-vnext-substrate.md`. The mission and questions below are
> retained as historical context for the promotion-era design (Stages 1–3C).

**Mission (historical, promotion-era).** Build a robust, extensible,
observable, safe, and empirically validated self-evolving agent harness: a
system in which an agent improves its own strategies, prompts, policies, and
(eventually) code by learning from evidence of its own behavior, under
explicit human-defined guardrails. The first prototype is an early
milestone, not the final scope.

## Central research and engineering questions (historical)

**Research questions**

1. Can an agent reliably improve itself from *its own execution traces* —
   evidence, not intuition — and how far does trace-driven improvement scale
   beyond planted weaknesses?
2. What acceptance rules make self-modification safe enough to automate? When
   is "strictly better, no regressions" too conservative (blocks exploration)
   or too permissive (overfits the evaluation suite)?
3. How do we distinguish genuine capability gains from reward hacking /
   evaluation overfitting, and what held-out validation makes gains
   trustworthy?
4. What is the minimal set of evolvable surfaces (strategy code, prompts,
   policies, tool configurations, memory) that yields compounding rather than
   one-shot improvement?
5. How should credit assignment work when a cycle changes multiple things, or
   when a change helps one task and harms another?

**Engineering questions**

1. What stage interfaces stay stable while implementations grow from
   deterministic stubs to model-backed components (adapters, tools, recursive
   delegation, durable memory, benchmarks)?
2. How is lineage represented so that any behavior of the system can be traced
   to the exact generation, decision, and evidence that produced it — and
   reversed?
3. What isolation is required at each maturity stage for candidate code, and
   where does the sandbox boundary live in the architecture?
4. How do we keep the whole loop reproducible (replayable from artifacts)
   once nondeterministic model calls enter the picture?

## What "learning from itself" means

The system learns from itself when a change to its own behavior is:

1. **Motivated by evidence** from its own recorded execution traces (failing
   cases, errors, timings) — not by an external patch or oracle knowledge;
2. **Produced by the system's own proposal mechanism**, operating only on a
   declared evolvable surface;
3. **Validated empirically** by running the candidate and comparing it against
   the incumbent under explicit rules; and
4. **Retained durably** with full lineage, so the improvement persists across
   restarts and remains attributable and reversible.

A hard-coded fix applied by a human is not learning. A model call that
rewrites a strategy without validation is not learning. Diagnosis → bounded
proposal → empirical validation → journaled acceptance is.

## Trusted versus evolvable surfaces

**Trusted (fixed within a cycle; changed only by humans via code review):**

- The loop controller (`loop.py`) and stage orchestration.
- The evaluator, the diagnoser's signature registry, and the acceptance rules
  (`evaluate.py`, `diagnose.py`, `decide.py`).
- The sandbox/runner boundary (`sandbox.py`, `strategy_runner.py`).
- The ledger and its append-only invariants (`store.py`).
- Task definitions and their expected outputs (`tasks.py`).

**Evolvable (may be changed by the loop, only through propose → validate →
accept):**

- **Strategy code** — v0's sole evolvable surface: standalone Python modules
  exposing `solve()`, executed only out-of-process.
- Planned: prompts, decision policies (e.g., retry/branching parameters), tool
  configurations, and retained memory contents.

The trust boundary is itself a design object: as the harness matures, pieces
may migrate from trusted to evolvable, but only with a validation regime
strong enough for that surface (e.g., the evaluator may never be evolved
against itself without an independent held-out check).

## Long-term quality attributes

- **Reliability** — the controller survives any candidate behavior (hang,
  crash, garbage output); every failure mode is a recorded outcome, not an
  exception that kills the loop.
- **Extensibility** — stages are narrow typed interfaces; adding a model
  adapter, a new task domain, a new evolvable surface, or a new evolution
  strategy means registering an implementation, not rewriting the loop.
- **Observability** — every cycle emits a structured event stream; every
  question of the form "why is the system behaving this way?" is answerable
  from artifacts alone.
- **Reproducibility** — deterministic components replay exactly; once model
  calls arrive, all inputs/outputs are journaled so cycles can be replayed or
  audited offline.
- **Safety** — candidates run isolated from the controller with resource
  limits; acceptance is conservative by default; the set of evolvable surfaces
  is an explicit allowlist.
- **Auditability** — the ledger is append-only; every generation carries its
  parent, the diagnosed weakness, the decision and its reason, and the full
  artifact needed to reconstruct it.
- **Efficiency** — evaluation cost is budgeted; validation effort scales with
  the risk of the change, not a fixed worst case.
- **Reversibility** — any accepted change can be rolled back by activation of
  an ancestor; rollback is itself a journaled, durable operation.

## Non-goals for the first milestone

- **Model-weight training** — no fine-tuning or gradient updates; evolution
  operates on artifacts around the model, not the model.
- **Production-grade sandboxing** — process isolation with timeouts is fault
  containment, not a security boundary against adversarial code.
- **Unrestricted self-rewriting** — the loop may not modify the trusted
  surfaces (controller, evaluator, acceptance rules, ledger).
- **Distributed orchestration** — single process, single machine, sequential
  cycles.
- **Production deployment** — this is a research harness; no SLAs, no
  multi-tenant concerns, no hardening for untrusted users.

## Maturity stages

1. **Thin prototype (current).** Deterministic task, planted weakness,
   signature-based diagnosis, registry of bounded patches, subprocess
   isolation, JSONL ledger, rollback. Proves the loop shape end to end.
2. **Model-in-the-loop proposals.** A model adapter interface; the proposer
   generates patches instead of looking them up; validation hardens (held-out
   cases, multiple seeds); all model I/O journaled for replay.
3. **Multiple surfaces and strategies.** Prompts and policies become
   evolvable; more than one evolution strategy (patch, rewrite, crossover,
   parameter search) competes; credit assignment across surfaces.
4. **Real tasks and benchmarks.** Agentic tasks with tools; benchmark suites
   with statistical acceptance criteria; efficiency budgets; regression
   corpora grown from past failures.
5. **Durable memory and online adaptation.** Retained knowledge as an
   evolvable surface; the system adapts between benchmark runs, not just
   within them; recursive delegation to sub-agents.
6. **Hardened harness.** Real sandboxing (containers/microVMs), resource
   quotas, adversarial-candidate threat model, distributed evaluation — the
   "serious harness" the mission describes.

Each stage keeps every earlier stage's tests green: the deterministic slice
remains the smoke test for the loop's integrity forever.
