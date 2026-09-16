# Architecture decision records

[ARCHITECTURE.md](../ARCHITECTURE.md) describes the current `strive`
implementation. ADRs 0009 onward record its harness, benchmark, feedback and
confinement decisions. ADRs 0001–0008 document earlier implementations and their
rationale; their module names, APIs and rollout status are historical.

| ADR | Decision | Status |
| --- | --- | --- |
| [0009](0009-harness-as-model.md) | Harness pluggability through bounded generation | Accepted; native profiles and funded execution separately gated |
| [0010](0010-benchmark-adapter-tau2.md) | General BenchmarkAdapter, tau2 telecom first | Accepted; installed workload qualification required |
| [0011](0011-feedback-contracts.md) | Feedback A/B and isolated audit; C deferred | A/B implemented; C unsupported |
| [0012](0012-linux-os-jail.md) | Linux OS jail confinement floor | Implemented; runtime capability checks required |
| [0013](0013-adaptive-whole-group-split.md) | Adaptive 49/29/36 whole-group split | Implemented; separate fixed-stock mode |
| [0008](0008-vnext-substrate.md) | Policy-neutral adaptation with optional comparison | Historical implementation; policy-neutral principle retained |
| [0001](0001-revisions-and-surfaces.md) | Harness revisions and evolvable surfaces | Historical; current bundles described in architecture |
| [0002](0002-scopes.md) | Artifact scopes and inheritance | Historical; current run/lineage grants described in architecture |
| [0003](0003-tasks-and-environments.md) | Tasks, datasets and environments | Historical; current benchmark boundary in 0010 |
| [0004](0004-evidence-and-selection.md) | Validation bundles and selection decisions | Universal promotion requirement superseded by 0008 |
| [0005](0005-evolution-algorithms.md) | Evolution algorithms and objectives | Reframed by 0008 as policy decisions |
| [0006](0006-storage-and-schema-evolution.md) | Storage and migrations | Historical; no migration into the current run format |
| [0007](0007-sandbox-boundary.md) | Earlier sandbox and model capability lane | Historical; current confinement floor in 0012 |

New ADRs use the next four-digit number and the Context / Decision / Consequences
format. Record the enduring choice, its reason and any qualification limits;
implementation progress belongs in [NOTES.md](../../NOTES.md).
