# ADR-0013: Adaptive whole-group assignment with actual counts 49/29/36

Status: accepted and implemented; selected-task grading and installed-runtime
qualification remain blocking.

## Context

An adapting actor can learn scenario-specific behavior from development
feedback. Randomly separating persona or failure-condition variants would leak
the same base scenario across development and audit. The selected telecom pool
has 114 tasks but only three generator roots, so target sizes of 60/14/40 cannot
be achieved with intact groups.

## Decision

Group by the generator's base-template stem, ignoring appended failure-condition
and persona variations. Shared words, goals and initial values do not join roots.
For non-generator contract fixtures, use exact canonical persona-free scenario
equality. Allocate whole groups deterministically, retaining source, seed,
ordering, memberships, target/actual sizes and feasibility. When at least three
groups exist, require three nonempty partitions before minimizing total absolute
size error, maximum error and the ordered partition errors. Stable hashed root
order and deterministic traversal resolve ties.

| Partition | Root | Tasks |
| --- | --- | ---: |
| Development | `[mms_issue]` | 49 |
| Validation | `[service_issue]` | 29 |
| Audit | `[mobile_data_issue]` | 36 |

Both adaptive and matched fixed-control arms use this assignment. Every selected
task appears once, without group crossing. Stock train/test overlap is an
informational diagnostic; deterministic grading and complete adaptive coverage
remain blocking gates. Fewer than three groups require explicit empty-partition
reporting and cannot support a three-way held-out claim.

Keep `fixed-stock` separate: all 40 published test IDs in stock order, a fresh
initial upstream `llm_agent` for each simulation, and no cross-episode adaptation.
It has its own certificate and results, and pins the user model to
`gpt-4.1-2025-04-14` at temperature `0.0`.

## Consequences

Three development passes total 147 episodes per trajectory. Plans, budgets and
coverage must use actual counts. Only three independent roots support a coarse
transfer experiment, not broad generalization or leaderboard equivalence.
Fixed-stock's actor implementation and population differ; its results cannot be
pooled with adaptive results, fed back to adaptation, or labeled as a 114-task
base leaderboard score. Preparation is not a performance result.

See [architecture](../ARCHITECTURE.md#benchmarks-and-telecom) and the
[tau2 guide](../../adapters/tau2/README.md).
