# ADR-0010: General benchmark adapters, with tau2 telecom first

Status: accepted; protocol, counter and isolated tau2 implementations exist.
Installed telecom qualification remains an explicit execution gate.

## Context

Stateful benchmarks have their own environments, user simulators and reward
rules. Embedding telecom-specific operations in the supervisor or verifier would
make each new benchmark a change to authority semantics.

## Decision

Define `BenchmarkAdapter` as `strive.benchmark/1`. It supplies task/split
descriptors, operation schemas, episode initialization, actor/user tools,
messages, termination, snapshots, lookup, trusted scoring and declared fork
support. The bridge expresses these as ordinary `ExecuteEffect` operations.
An operation store atomically binds effect identity and arguments to state
changes and receipts. Recovery reuses committed mutations; opening a snapshot
cannot rewind the current environment.

Use tau2 telecom text as the first external workload, pinned to upstream commit
`a2c024725189473d2d7cea3a5cfdbcc67478e41f` and distribution `1.0.1`. Keep its
implementation, dependencies and original data in a separately retained adapter
environment accessed over bounded JSON RPC. Broker user-model generation
separately from simulator operations. The scorer uses committed receipt/state
chains and deterministic upstream evaluation. Missing or unknown reward bases,
natural-language assertions, unreviewed assertions and failed strict reference
checks block selected-task qualification.

## Consequences

The pure verifier imports no benchmark implementation and does not rerun reward
logic. The counter adapter demonstrates reuse without core changes. New
benchmarks must qualify their own operation recovery and scorer semantics.
Retained task coverage and grading evidence are prerequisites to scientific
results. Snapshots do not imply that `EvaluateFork` enactment is implemented.

See [architecture](../ARCHITECTURE.md#benchmarks-and-telecom), the
[tau2 guide](../../adapters/tau2/README.md) and
[ADR-0013](0013-adaptive-whole-group-split.md).
