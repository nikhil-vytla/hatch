# strive project charter

Strive provides durable mechanisms for model-led adaptation. Agents may change
executable code, prompts and memory during continuing operation. A fixed outer
runtime preserves what ran, controls access, accounts for effects and recovers
honestly. The value is inspectable, reproducible execution under declared
assumptions; a positive improvement result is not guaranteed.

[ARCHITECTURE.md](ARCHITECTURE.md) defines the current implementation and
[the ADRs](adrs/README.md) record its decisions. The project assumes one trusted
host and operator, hostile generated code and inputs, and local durable storage
that survives process failure.

## Fixed guarantees

1. Confine candidate execution and keep authorization, accounting, measurement
   and recovery outside its control.
2. Derive authoritative facts from trusted producers and scorers, with evidence
   access constrained by the bound feedback contract and actual grants.
3. Retain exact execution identities, requests, bundles, reservations and
   continuation cursors before their effects depend on them.
4. Reuse recorded outcomes and supported recovery contracts. Preserve unknown
   outcomes and charges rather than silently retrying or clearing obligations.
5. Check every authority transition through a small pure protocol that can
   represent failure, overruns and uncertainty.

## Policy and scientific scope

Policies choose what to change, when to compare, and whether to keep, revise or
restore a bundle. There is no universal empirical-promotion requirement.
Restoration changes configuration; it never undoes external actions or spending.

The research workflow pins manifests and study plans, separates development from
blind audit, and reports coverage, costs and uncertainty. Feedback A is the
reference comparison contract; B permits declared validation feedback and
requires a fresh final audit. C, a private deployment veto, is deferred. Reports
separate execution integrity, feedback exposure and comparison strength.

The first external workload is separately installed tau2 telecom through the
general benchmark interface. Its adaptive 49/29/36 whole-group split and its
40-task fixed-stock evaluation are distinct experiments. The executable CLI
currently demonstrates the workflow with the recorded counter fixture. Native
harness profiles, installed telecom qualification and a funded campaign remain
explicit gates, as described in [ROADMAP.md](ROADMAP.md).

## Boundaries

The current system is a local Python runner with serial effects, immutable
bundles, a journal/CAS, trusted adapters, bounded candidate execution and Linux
confinement where qualified. It is not a distributed scheduler or hosted
experiment service. Model-weight changes, generated privileged adapters,
arbitrary controller-state migration, global mutable cross-run memory and
host-loss failover are outside scope.

New vNext runs use their own format and roots. Existing legacy histories retain
their original interpretation; there is no migration or compatibility layer.
Earlier project documents remain in [the archive](archive/README.md).
