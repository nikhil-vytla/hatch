# strive roadmap

The [architecture](ARCHITECTURE.md) describes the implemented `strive`
boundaries. Work remaining is qualification and explicit capability extensions,
not the earlier kernel rollout described in the historical ADRs.

## Implemented mechanisms

- Typed authority records, immutable CAS, authenticated framed journals, pure
  preflight/replay, local writer leases and durable execution epochs.
- Serial supervisor, scoped admission, budget reservations and settlement,
  supported reconciliation, uncertainty retention and single result consumption.
- Complete executable bundles, bounded actor/controller steps, continual
  refinement, atomic activation and restoration with evidence provenance.
- Deno permissions and the Linux jail, with runtime capability checks, hard
  cgroup limits, bounded scratch and whole-tree cleanup.
- Bounded harness generation adapters and a trusted single-request gateway.
- General BenchmarkAdapter, counter and isolated tau2 telecom implementations,
  transactional simulator operations and trusted scoring.
- Feedback A/B, serial studies, actor freeze, isolated audit, journal-derived
  comparison/inspection and optional OTLP export with Langfuse.

## Qualification and reference campaign

1. Run the prepared Linux verification stack. Required jail and installed tau2
   checks must execute and pass, including both certificate modes, deterministic
   scorer equivalence and mutation recovery. Retain the report and dependency
   closure. A green host run with capability skips cannot close this gate.
2. Qualify each native harness executable/configuration against the gateway's
   single-request contract inside the jail. Version detection, adapter fixtures
   and jail availability are insufficient on their own.
3. Compose and qualify the adaptive telecom campaign path. The manifest CLI
   currently supports the recorded counter workflow and rejects native harness
   manifests. The standalone fixed-stock runner is a separate upstream-actor
   baseline, not that campaign composition.
4. Bind explicit funded limits and a protected audit allocation before live
   dispatch. Retain provider bounds, model settings, prices, selected task IDs,
   ordering, workload closure and the analysis plan.
5. Run and report fixed versus adapting actors under feedback A using the same
   initial actor and adaptive assignment. Report negative, incomplete or
   inconclusive results with coverage and expenditure intact.

The adaptive assignment has 49 development, 29 validation and 36 audit tasks.
Three development passes mean 147 episodes per trajectory. Its three scenario
roots permit only a coarse transfer claim. Fixed-stock uses all 40 stock test
IDs and reports separately; neither mode silently inherits another population's
leaderboard meaning. See [ADR-0013](adrs/0013-adaptive-whole-group-split.md).

## Deferred capabilities

`EvaluateFork` is a declared command with unsupported enactment and an explicit
expected-failure test. It needs approved verifier/supervisor authorization and
accounting changes plus an adapter with actual fork support. Immediate bundle
activation does not depend on it.

Feedback C needs a distinct private-control channel, query accounting and fresh
audit. It cannot be added as an annotation or an implicit access grant.

Other deferred work includes arbitrary controller-state migration, model-weight
updates, generated privileged adapters, remote/concurrent workers, distributed
budget coordination, persistent verification caches, external history anchors,
host-loss recovery and additional viewer profiles. A custom web UI and hosted
experiment service are outside the present scope.

[HANDOFF.md](HANDOFF.md) contains operational verification commands. Earlier
roadmaps remain in [the archive](archive/README.md).
