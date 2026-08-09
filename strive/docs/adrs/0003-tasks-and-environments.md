# ADR-0003 — Task spec versions, dataset revisions, environments

Status: accepted design; wire schemas PROVISIONAL until this ADR's implementation slice (see adrs/README freeze table).

## Context

Today a `Task` is one frozen dataclass mixing *what the task is* (id,
signature, scoring, catalog) with *what data evaluates it* (the case tuple),
fingerprinted together. That made phase 4.6's drift guard blunt: adding a
regression case — a routine, desirable event — would trip the same
"task-fingerprint drift" acknowledgement as changing the task's meaning.
And the kernel is coupled to `solve(str) -> int`, which cannot describe
stage-4 agentic tasks.

## Decision

**Split immutable spec from mutable data.**

- `TaskSpecVersion` — immutable and **environment-generic**: `task_id`,
  `version`, `description`, `environment` (adapter id@version),
  `action_schema`, `observation_schema`, `scorer` (id@version),
  `config_ref` (CAS blob of adapter-specific config), spec `fingerprint`.
  The kernel never sees a function signature: `solve(str) -> int` and the
  primitive catalog are fields of the **FunctionTask config blob**, not the
  spec. Changing any spec field is a new version and (for mutation against
  old-lineage state) keeps requiring the explicit drift acknowledgement.
- `DatasetRevision` — append-friendly and **fully reconstructable**:
  `dataset_id`, monotonically increasing `revision`, `parent_revision`, a
  `reason` (e.g. "regression: captured failing input from run-X"),
  **per-split CAS manifest refs** (each split's case list is addressable, so
  any historical evaluation re-materializes exactly), per-split counts (a
  derivable convenience), and the dataset `fingerprint`.
  **Growing the regression split creates a new DatasetRevision and a
  re-evaluation requirement — never a task-drift acknowledgement.** The
  incumbent must be re-baselined under the new revision before candidates are
  compared on it (otherwise paired comparisons silently mix datasets).

**`EvaluationManifest` pins everything a validation ran under**: the
`ResolvedHarnessManifest` ref (the run-resolved effective bindings under
test — never a revision's own scope manifest), the
objective spec ref, task and dataset fingerprints, environment and scorer
ids (name@version), tool versions, the runtime (e.g. `cpython-3.12.10`),
the seed tuple, the validator list (name@version), and the `BudgetSpec`.
Evaluation manifests are **owned by ValidationBundles, never by revisions**
(ADR-0001/0004): one revision is routinely evaluated under many manifests.
That ownership is what makes "re-evaluation required" mechanical: a decision
whose evidence pins an outdated dataset revision is visibly stale.

**Session protocol with capability mix-ins (future-proofing, not
implemented now).** Requiring `reset` in the base contract was wrong — the
Continual Harness domain is exactly a world without free resets. The base is
a plain episodic session, with capabilities as optional protocols the kernel
probes for:

```python
class EnvironmentSession(Protocol):
    def observation(self) -> object: ...
    def act(self, action: object) -> object: ...
    def done(self) -> bool: ...
    def close(self) -> None: ...

class Resettable(Protocol):      # paired evaluation wants this
    def reset(self, case_ref: str, seed: int) -> None: ...
class Checkpointable(Protocol):  # long-horizon recovery
    def checkpoint(self) -> str: ...
    def restore(self, checkpoint_ref: str) -> None: ...
class Forkable(Protocol):        # counterfactual validation (exo, note 04)
    def fork(self) -> EnvironmentSession: ...
```

with a `Trajectory` record (ordered steps, budget usage, terminal outcome)
as the unit evaluators score — NOOA's ATIF is the reference for how strict a
versioned trajectory schema pays off (note 06). The kernel couples to
*manifests and trajectories*, not to any function signature.

**`FunctionTask` adapter keeps today's tasks.** `solve(str) -> int` becomes a
one-step environment: `reset` yields the input text, the single `step`
submits the integer, the trajectory has length one. The existing sandbox
runner is unchanged — the adapter lives kernel-side. Rejected alternative:
rewriting the runner protocol now; there is no consumer for multi-step
trajectories until stage 4, and the runner's loud-schema property is
load-bearing.

## Consequences

- The `Task` dataclass splits in the FunctionTask slice (after Stage 3B,
  which is dual-write revision storage only); `TASKS` becomes a registry of
  (spec version, current dataset revision) pairs; `fingerprint()` splits into
  spec and dataset fingerprints; the drift guard narrows to spec
  fingerprints. None of this lands in Stage 3B.
- Automatic regression growth (deferred since 4.5) gets its mechanism:
  append case → new DatasetRevision → forced incumbent re-baseline.
- Seeds enter manifests now so stochastic validation (ADR-0004) does not need
  a schema change later.

## Sources: borrowed / rejected / deferred

- **Borrowed** — NOOA: versioned, test-enforced trajectory schema (note 06);
  GEPA: budgets pinned to evaluation units (note 01); CH: milestone-style
  progress measures live in the evaluator, not the environment (note 03).
- **Rejected** — coupling kernel to a richer function signature (just a
  bigger version of the same mistake); mutable in-place case lists.
- **Deferred** — tool-call actions and snapshot/fork-able environments (exo's
  sandbox teleport, note 04) until stage 4/6; multi-episode environments.
