Milestone 1 freezes the additive Python contracts in `strive.vnext.contracts`.
[ASTRA_DESIGN.md](../../../docs/ASTRA_DESIGN.md), including Amendment 1, is the
authority. Amendment 1 takes precedence wherever the earlier design conflicts.

The package defines the closed authoritative record groups and their owners,
open bounded annotations, the seven commands and `Step` protocol, effect states
and recovery tables, `strive.harness/1`, authored/resolved manifests, A/B/C
feedback permissions, tau2 simulator acceptance scenarios, and the reference
campaign plan. Registry backend names remain strings. The interface adds no
harness-specific record family and no second command representation.

All code is definitions and pure construction/validation helpers. The TOML
loaders accept text, never paths. `load_authored_manifest` retains authoring
references; `load_resolved_configuration` requires SHA-256 references.
`ResolvedManifest` additionally requires the retained closure, effective model
settings, declared enabled cost phases, and adapter recovery capabilities.
It does not fetch, resolve, hash, execute, or authenticate anything.

The default policy validator accepts `refine_every_episodes` and
`optional_dev_forks`. A pinned policy can supply its own pure parameter validator;
only policy parameters are extensible. Core tables always reject unknown keys.
The amended workload keeps the original `task_stream` and corpus field names,
with task/episode artifacts behind their references. A validation corpus may be
omitted under A; binding it does not grant access. Contract C is represented but
rejected for execution configuration.

Money uses integer nanodollars, with exact decimal TOML parsing. `SETTLED` means
known components were booked; it does not mean usage is complete. Unknown
components retain obligations after continuation. An uncertain outcome must be
reconciled before it can produce a consumable result. Authorization without a
durable outcome always requires reconciliation or suspension. A recorded local
failure or reconciled outcome can reach `RETURNED` without a dispatch observation.
Late reconciliation is separate from reopening execution.

The envelope wraps six authoritative payload classes or an `Annotation`.
Annotation JSON may contain arbitrary claims, including familiar authority key
names, but those bytes have no authority. Annotations have no authority fields
of their own. The frozen per-record annotation bound is 65,536 UTF-8 JSON bytes;
run storage quotas remain a later enforcement responsibility. Owner declarations
and producer fields are not authentication.

[Acceptance tests](../../../tests/vnext/test_acceptance_contracts.py) name each
integrity guarantee and contract deliverable. Five strict expected failures also
contain the future runtime assertions. Their shared driver deliberately raises
`NotImplementedError`; the named milestones must supply real fault probes and
remove the markers. Passing the schema tests is not evidence of confinement,
durability, scorer correctness, or feedback noninterference.

Milestone 2 starts with an isolated artifact root, immutable CAS publication,
framed commits and one-writer ownership, then pure preflight and full replay.
Producer-specific append interfaces must enforce the ownership declared here.
Its first runtime acceptance case is fresh-interpreter replay that rejects
corrupt authority without importing candidate code. Existing modules remain
unchanged until the human contract review preceding teardown.
