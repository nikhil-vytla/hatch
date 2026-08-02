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
> The repository implements content-addressed GSM8K source, asset, task, and
> verifier identity; native final-answer grading; atomic public artifact
> publication; and locked replay. The Evolving Intent method remains a contract,
> not an executable synthesis implementation.

[`docs/architecture.md`](docs/architecture.md) maps the research model to the
implemented records and states their identity, admission, publication, and
replay invariants.

> **TODO:** Implement GSM8K Evolving Intent synthesis with behavioral
> regression coverage for the documented contracts.

> **TODO:** Implement controlled experiment execution with matched arms,
> retained run evidence, and declared estimands.

Run the implemented core checks from `parallax/`:

```shell
PYTHONPATH=src python -m unittest discover -s tests -v
uvx mypy src
python -m ruff check src tests
```
