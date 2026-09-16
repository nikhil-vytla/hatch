# vNext implementation

[Architecture](../../../docs/ARCHITECTURE.md) defines the current design and its
five integrity guarantees. [ADRs](../../../docs/adrs/README.md) record the durable
decisions. This package has its own run format and artifact roots; it neither
reads nor migrates legacy histories.

| Package | Responsibility |
| --- | --- |
| `contracts` | Closed authority records, typed commands, manifests, feedback contracts and bindings. Constructors validate shape, not producer authenticity. |
| `store`, `codec`, `wire` | Immutable SHA-256 objects, framed journals, authenticated producer ports and retained execution epochs. |
| `verify` | Pure preflight and replay into `VerifiedState`, without dispatch, candidate execution or benchmark imports. |
| `runtime` | Serial supervisor, capability admission, budget ledger, Deno permissions and the Linux OS jail. |
| `harness` | Bounded generation adapters, provider gateway, exact request/response retention and recovery. |
| `benchmarks` | General `BenchmarkAdapter`, episode operations, transactional receipts and trusted scoring. Counter and tau2 implementations live under `adapters/`. |
| `policy` | `ContinualRefine`, complete bundle validation, scoped evidence, brokered refinement and atomic activation/restoration. |
| `cli`, `study` | Manifest resolution, retained run identities, serial studies, frozen actor handoff and isolated audit. |
| `report`, `telemetry` | Journal-derived inspection, comparisons and optional OTLP projection with a Langfuse profile. |

`ArtifactStore` defaults to `artifacts-vnext`; the workflow CLI defaults to
`artifacts-vnext-workflow`. A `RunWriter` holds a local lease. Trusted setup hands
each producer its own `ProducerPort`; append derives identity from that port and
checks the current epoch. Referenced objects are synced before their journal
frame commits. Protected verification keys assume a trusted local host and
operator, not a portable public signature.

`RunReader` opens existing data without creating it. `verify.replay()` checks the
whole history, and `verify.preflight()` checks a transition against a verified
prefix. Missing objects, invalid authentication, malformed committed frames and
inconsistent transitions stop mutation. An incomplete final frame raises
`IncompleteTail`; execution readers never silently truncate or repair history.
Annotations remain bounded opaque bytes and cannot authorize effects, settle
usage, change revisions or certify reward.

Candidate steps run through `runtime.confined_sandbox.DenoSandbox`. A qualified
Linux jail adds namespaces, seccomp, hard cgroup limits and bounded scratch.
Unsupported hosts retain the permission sandbox with an explicit deferred OS
floor. Native CLI qualification is a separate gate from jail availability.

`uv run python -m strive.vnext.cli --help` lists the manifest workflow commands.
The current composition runs the counter adapter and a recorded provider; it
rejects native harness campaign manifests. The tau2 adapter is separately
installed and qualified. `EvaluateFork` enactment, private-veto feedback C and
funded reference campaigns remain deferred or gated.

[Tests](../../../tests/vnext/) cover the runtime boundaries, recovery, scoped
feedback, report provenance and replay purity. Permanent core hash fixtures live
in [baselines](../../../tests/vnext/baselines/README.md). See the
[handoff](../../../docs/HANDOFF.md) for host and Linux verification commands.
