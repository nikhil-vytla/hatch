The vNext implementation follows [ASTRA_DESIGN.md](../../../docs/ASTRA_DESIGN.md)
and Amendment 1. The amendment wins wherever the earlier design conflicts.

Milestone 1 froze `contracts`: authority record groups and owners, annotations,
the seven commands and `Step` interface, lifecycle/recovery tables, harness
bindings, manifests, feedback access, simulator cases, and the reference study.
Those types remain unchanged. Their constructors validate shape, not producer
authenticity. TOML loaders accept text and do no resolution or execution.

Milestone 2 adds `store`, `verify`, `codec`, `wire`, and shared errors. See the
[implementation report](../../../milestone-2-storage-verification/README.md)
for the format, trust assumptions, semantic decisions, and acceptance-test map.

`store.ArtifactStore` defaults to `artifacts-vnext`. It publishes immutable
SHA-256 objects and creates runs with protected producer bindings. It rejects
populated roots without its format marker and never reads legacy artifacts.
A `RunWriter` holds an exclusive local lease and durable execution epoch.
Trusted setup hands each pinned producer only its `ProducerPort`. Append takes
the current epoch and derives producer identity from that port. Referenced
objects and directory entries are synced before committing a journal frame.

`store.RunReader` opens existing journal/CAS data without creating files.
`verify.replay(journal, objects, authority)` reconstructs an immutable
`VerifiedState`; `verify.preflight(state, frame, objects, authority)` checks one
new transition against a verified prefix. The verifier imports only stdlib,
frozen contracts, and shared wire/codec definitions. It does not import mutable
storage implementations, execute candidate code, or dispatch effects.

Producer MACs and supervisor seals authenticate the append path under a trusted
local host. The protected authority file contains verification keys and pinned
producer identities. Candidates must receive neither that file nor general
CAS/history handles. This local authentication is not a portable signature or
a defense against a host owner rewriting the entire run and trust root.

The frozen `Annotation` constructor accepts bounded UTF-8 JSON. Storage's
`opaque_annotation(namespace, bytes)` and decoder reuse the same type while
checking only the namespace and 65,536-byte bound. Verification never parses
annotation payloads, including unknown schemas and non-JSON bytes.

A corrupt reference, malformed record, invalid MAC, broken chain, inconsistent
transition, or reused result cursor raises. A partial final frame raises
`IncompleteTail` with its byte offset. Readers and writers never truncate,
skip, or automatically repair damaged history.

[Acceptance tests](../../../tests/vnext/test_acceptance_contracts.py) now close
runtime guarantee 5 with guarded fresh-interpreter replay and corruption
rejection. The other four runtime probes remain strict expected failures for
later milestones. Legacy modules remain intact; vNext has no compatibility
format or dual writes.
