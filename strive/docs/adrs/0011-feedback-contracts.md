# ADR-0011: Feedback A and B, with private veto C deferred

Status: accepted; A and B implemented, C explicitly unsupported.

## Context

Feedback can influence an agent through model context, selection, stopping,
retrieval, summaries, budgets or dashboards. Hiding raw scores alone does not
preserve a blind evaluation. Evidence access and claims about held-out data need
an explicit campaign contract.

## Decision

Contract A permits declared development evidence to influence adaptation and
selection. It is the reference scientific comparison contract. Contract B also
permits explicitly granted validation evidence for development and requires a
declared validation corpus. Once consulted, validation is consumed evidence and
cannot support an
untouched-held-out claim. Operational failures require the declared access and
settings in either contract. The contract and broker grants intersect before
bytes are read; a contract label never grants retrieval by itself.

Both contracts require a fresh isolated audit. Freeze the selected actor and
development journal head before the one-way handoff. Audit has separate state,
services, grants, caches, accounting and report destinations. Its results cannot
reopen development or candidate selection, and publication requires a matching
release marker.

Contract C would let private feedback veto deployment or selection. Defer it
until a separate control channel, query accounting and a fresh final audit exist.
Do not model a veto as harmless diagnostics or silently grant private access.

## Consequences

A and B share execution machinery; their permitted influence differs. Derived
memory retains source scope and cannot launder protected evidence. Reports label
execution integrity, feedback exposure and comparison strength independently.
A valid B run can support descriptive research without claiming a blind,
controlled improvement result.

See [architecture](../ARCHITECTURE.md#continual-refinement-and-feedback).
