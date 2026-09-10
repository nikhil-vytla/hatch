# ADR-0009: Harness pluggability through bounded generation

Status: accepted; adapter and gateway mechanisms implemented. Native CLI drives
and funded campaigns require separate qualification.

## Context

A model harness can construct requests and decode proposals, but giving its
internal loop direct tools, credentials or accounting authority would bypass
Strive's execution guarantees. Swapping harnesses must preserve the outer effect
lifecycle and the meaning of recorded expenditure.

## Decision

Treat the harness as a bounded model-generation service. Adapters implement
`describe`, `prepare`, `invoke` and `reconcile`, pinned by executable,
configuration, decoder and model settings. Strive owns the workload loop, tools,
scorer, bundles and continuation. opencode, Codex and Claude Code use this same
boundary.

An effect-scoped gateway admits one bounded text request, retains its exact wire
bytes and provider response, and owns credentials and usage evidence. Extra
requests, hidden retries, tools and unsupported billing/session behavior are
rejected. Requested, wire and provider-observed model identities stay separate.
Recovery uses retained responses or a declared provider recovery contract, never
native session resume or a transcript ID.

## Consequences

Harness output is proposal data; CLI usage totals are diagnostics. Conservative
provider bounds are required before paid dispatch, and unknown usage retains an
obligation. A Linux jail can confine the process tree without proving that a
vendor CLI obeys the single-request profile. Deterministic adapter fixtures,
native profile qualification and funded smokes remain distinct evidence.

See [architecture](../ARCHITECTURE.md#confinement-and-model-harnesses) and
[ADR-0012](0012-linux-os-jail.md).
