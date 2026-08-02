# Parallax

Parallax is a research harness for identifying modern-agent failure modes,
turning them into research questions about agent training and RL environments,
synthesizing novel or harder but verifiable tasks from existing benchmarks and
codebases, and running controlled experiments with trustworthy evidence.

[`docs/MODEL.md`](docs/MODEL.md) defines the task, environment, synthesis,
admission, controlled-arm, evidence, and estimand vocabulary used by Parallax.

[`docs/methods/evolving-intent.md`](docs/methods/evolving-intent.md) defines
Evolving Intent as one strategy in that model and records the published method,
source links, interpretation policy, and evidence limits.

> [!NOTE]
> The repository currently defines the research model and Evolving Intent
> method contract. It does not contain executable synthesis, experiment
> execution, generated benchmark pools, provider transcripts, or paper-score
> reproduction.

> **TODO:** Implement the content-addressed domain and native-verifier core.

> **TODO:** Implement GSM8K Evolving Intent synthesis with behavioral
> regression coverage for the documented contracts.

> **TODO:** Implement controlled experiment execution with matched arms,
> retained run evidence, and declared estimands.
