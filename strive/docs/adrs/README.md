# Architecture decision records

[ARCHITECTURE.md](../ARCHITECTURE.md) describes the current `strive`
implementation, decided in ADR-0015. ADRs 0001–0014 document the Python
implementation (git tag `strive-py-final`) and earlier designs. Their module
names and APIs are historical; the principles ADR-0015 lists as surviving
still hold.

| ADR | Decision | Status |
| --- | --- | --- |
| [0020](0020-learning-triggers.md) | Learning triggers, a cheap pre-filter, and the `learning` setting | Accepted; idle and every-N-turns triggers implemented; amended: no `gated`, `off` by default |
| [0021](0021-eval.md) | `strive eval`: whether learning helps, frozen vs learning on a paired task sequence | Accepted; built as `scripts/eval`, run 2026-09-30 |
| [0022](0022-bullet-proposals.md) | Memory proposals change one bullet, each with a source; per-bullet accept and rollback | Accepted, built |
| [0023](0023-checks.md) | Verification checks: a command the daemon runs after a turn's changes, learned like a skill | Accepted, built |
| [0024](0024-slash-commands.md) | Slash commands: a prompt saved as a file, expanded by the daemon, learned like a skill | Accepted, built |
| [0025](0025-path-rules.md) | Rules scoped by path: guidance given with the first file it covers in a session | Accepted, built |
| [0026](0026-bullet-use.md) | How each memory bullet fares: given, cited by the agent, and the trouble after | Accepted, built |
| [0027](0027-code-extensions.md) | Code extensions: tools the agent writes, run in the command sandbox, accepted by a person | Accepted, built |
| [0028](0028-hooks.md) | Hooks: an accepted extension's code before each tool call, which may only ask or refuse | Accepted, built |
| [0029](0029-acp-server.md) | `strive acp`: editors drive a strive session over the Agent Client Protocol | Accepted, built |
| [0030](0030-durability-lessons-from-pi-durable.md) | Four durability changes learned from pi-durable: safe reruns, cut-off replies kept, hook answers recorded, idempotent prompts and forks | Accepted; 1, 2.1, 3 and 4.1 built |
| [0019](0019-predictions-checked.md) | Predictions are checked by a watch the daemon evaluates | Superseded (deleted 2026-09-28) |
| [0018](0018-replay-gate.md) | The replay gate runs past tasks again in scratch copies | Superseded (deleted 2026-09-28) |
| [0017](0017-judge-gate.md) | The judge gate is the daemon's own model call | Accepted; M9 implemented; amended: the judge advises |
| [0016](0016-trusted-learning.md) | Trusted learning: proposals, the daemon's checks, a person's decision | Accepted; M7, M8, M9, M10, M11 and triggers implemented |
| [0015](0015-rebuild-daemon-and-host.md) | Rebuild as a usable agent on a Rust daemon with thin clients | Accepted; M0 implemented |
| [0009](0009-harness-as-model.md) | Harness pluggability through bounded generation | Historical (Python); Accepted; native profiles and funded execution separately gated |
| [0010](0010-benchmark-adapter-tau2.md) | General BenchmarkAdapter, tau2 telecom first | Historical (Python); Accepted; installed workload qualification required |
| [0011](0011-feedback-contracts.md) | Feedback A/B and isolated audit; C deferred | Historical (Python); A/B implemented; C unsupported |
| [0012](0012-linux-os-jail.md) | Linux OS jail confinement floor | Historical (Python); Implemented; runtime capability checks required |
| [0013](0013-adaptive-whole-group-split.md) | Adaptive 49/29/36 whole-group split | Historical (Python); Implemented; separate fixed-stock mode |
| [0014](0014-non-benchmark-workloads-scope.md) | Non-benchmark workloads need no core changes | Historical (Python); Finding + minimal proof; real-environment adapter and generic driver unbuilt |
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
