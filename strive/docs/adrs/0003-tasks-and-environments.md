# ADR-0003 — Task spec versions, dataset revisions, environments

Status: accepted (Stage 3A).

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

- `TaskSpecVersion` — immutable: `task_id`, `version`, `description`,
  `signature`, `primitive_catalog`, spec `fingerprint`. Changing any of these
  is a new version and (for mutation against old-lineage state) keeps
  requiring the explicit drift acknowledgement.
- `DatasetRevision` — append-friendly: `dataset_id`, monotonically increasing
  `revision`, per-split case counts, dataset `fingerprint`, `parent_revision`,
  and a `reason` (e.g. "regression: captured failing input from run-X").
  **Growing the regression split creates a new DatasetRevision and a
  re-evaluation requirement — never a task-drift acknowledgement.** The
  incumbent must be re-baselined under the new revision before candidates are
  compared on it (otherwise paired comparisons silently mix datasets).

**`EvaluationManifest` pins everything a validation ran under**: task spec
fingerprint, dataset revision fingerprint, seed tuple, environment id,
validator list (name@version), and the `BudgetSpec`. Bundles and decisions
(ADR-0004) reference manifests, which is what makes "re-evaluation required"
mechanical: a decision whose manifest names an outdated dataset revision is
visibly stale.

**Environment protocol (future-proofing, not implemented now).** The kernel's
long-term execution contract is episodic:

```python
class Environment(Protocol):
    def reset(self, case_ref: str, seed: int) -> Observation: ...
    def step(self, action: Action) -> StepResult: ...   # observation, done, info
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

- The `Task` dataclass splits in Stage 3B; `TASKS` becomes a registry of
  (spec version, current dataset revision) pairs; `fingerprint()` splits into
  spec and dataset fingerprints. Drift guard narrows to spec fingerprints.
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
