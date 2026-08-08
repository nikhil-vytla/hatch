# ADR-0005 — Evolution algorithms and objective specs

Status: accepted — wire schemas revised in the 3A revision pass (2026-08-08), re-validated by spike round-trip tests, and frozen for Stage 3B.

## Context

The loop currently *is* the algorithm: one diagnose → propose → validate →
decide pass per cycle (incumbent hill climbing with population size one).
Stage 3 wants a GEPA-style population search competing with hill climbing
under equal budgets — without letting any algorithm bypass the gate, and
without proposal prompts hard-coding one acceptance formula ("strict
improvement with zero regressions") that stops being true under Pareto
retention or stochastic policies.

## Decision

**Four separated responsibilities.** Proposal generation (`Proposer`,
unchanged), candidate search (`EvolutionAlgorithm`, new), validation
(validators producing bundles, ADR-0004), and promotion (selection policies
producing decisions). Only the kernel executes candidates, appends journal
entries, or activates revisions — algorithms *request* these through a narrow
service handle.

**`EvolutionAlgorithm` protocol:**

```python
class EvolutionAlgorithm(Protocol):
    name: str
    version: int
    def run(self, services: KernelServices, budget: BudgetSpec) -> AlgorithmReport: ...
```

`KernelServices` exposes exactly: `propose(request) -> ProposalResult`,
`validate(revision) -> ValidationBundle`, `submit(candidate_revision,
evidence) -> SelectionDecision`, and read-only history/frontier queries.
Every call is charged to the algorithm's budget by the trusted meter; the
algorithm can *spend differently* (one deep lineage vs. a wide population)
but cannot spend more, which is what makes "two algorithms under equal
budgets" a fair experiment.

**Honest boundary statement:** the services handle prevents bypass **by API
contract, not by hostile-plugin isolation**. Algorithms are trusted L1
extensions — human-reviewed Python in the kernel process, like validators
and policies. The handle makes *accidental* gate bypass structurally
awkward (there is no API to activate or journal directly); it does not
contain a malicious plugin, which could import the store like any in-process
code. Process-level isolation applies to *candidates*, not to L1 plugins;
containing untrusted plugins is out of scope until the stage-6 threat model.

**Resumable search state is journaled, not in-memory.** Two records:
`AlgorithmRun` (algorithm name@version, run id, scope, budget, status ∈
{running, completed, halted}, `steps_completed` as the resumption cursor)
and `AlgorithmStep` (run id, step index, action ∈ {propose, validate,
submit}, subject ref, budget usage). A crashed search resumes from its last
journaled step; the frontier itself is journaled state via `frontier_add`
decisions (ADR-0004), never algorithm memory.

Planned implementations: `hill-climb@1` (exactly today's loop, extracted) and
`pareto-population@1` (GEPA-style: maintain a frontier via `frontier_add`
dispositions, sample parents from it, propose mutations).

**`ObjectiveSpec` — versioned, trusted, consumed by prompts.** A named
artifact (`objective-spec` kind, name@version) declaring `objectives`
(metric, direction, weight) and `constraints` (metric, bound, hard/soft).
`build_prompt` renders the spec instead of hard-coding the acceptance
sentence; selection policies declare which spec they enforce, so the prompt's
promise and the gate's behavior come from one place. The spec is *not*
evolvable in Stage 3 (it is the evaluator's voice; evolving it is the
trust-boundary erosion risk the charter flags).

**Rejected alternatives.** (a) Algorithms as loop subclasses — inheritance
would let an algorithm override gate calls; composition over a services
handle makes bypass structurally impossible. (b) Letting algorithms own
their populations in memory/files — unjournaled frontiers can't resume,
can't be audited, and invite exactly the drift CH documented.

## Consequences

- `run_cycle` becomes `hill-climb@1.run()` plus kernel scaffolding in Stage
  3B/C; the CLI grows `--algorithm` when the second algorithm lands.
- Budget accounting gains an `algorithm` attribution field on usage events.
- The stall detector generalizes to "no promote verdict in N algorithm
  iterations", parameterized per algorithm.

## Sources: borrowed / rejected / deferred

- **Borrowed** — GEPA: budget-capped reflective search over a Pareto frontier
  (note 01); RLM: children inherit *remaining* budget — algorithms get the
  same inheritance when they delegate (note 05).
- **Rejected** — CH's refiner-owns-everything shape (proposal, application,
  and "selection" fused, note 03); exo's algorithm-modifies-harness-directly.
- **Deferred** — crossover/merge operators (schema-ready via multi-parent
  revisions); meta-search over algorithm hyperparameters; concurrent
  algorithm execution (single-writer journals first, ADR-0006).
