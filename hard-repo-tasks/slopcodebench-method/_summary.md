Parallax's second synthesis method — checkpoint evolution, drawn from
[SlopCodeBench](https://arxiv.org/abs/2603.24755) — now has its formal
underpinnings: a model in MODEL.md vocabulary where the agent's own terminal
workspace becomes the next stage's initial state and sealed test obligations
accumulate monotonically, making non-destructive accumulation the integrity
invariant dual to Evolving Intent's terminal restoration. The design splits
quality measurement into three authority classes (native verification via
future-stage and probe verdicts, sealed deterministic metrics like erosion
and verbosity, and unsealable LLM-judged outcomes), poses eight falsifiable
research questions the single-episode method cannot ask, and specifies a
repeatable synthesis pipeline with six admission gates — including a
churn-ratio gate that mechanizes the
[slop-code-bench](https://github.com/SprocketLab/slop-code-bench) authors'
hand judgment of "does this test design decisions." The resulting method doc
lives at `parallax/docs/methods/checkpoint-evolution.md`, marked proposed and
not implemented.

- Strongest experiment: the `carry-reference` matched arm, which tests the
  self-accumulation mechanism the benchmark asserts but never controls for.
- The paper's own sensitivity data shows erosion predicts next-checkpoint
  cost, not pass rate; static "slop" metrics are sealable but must not be
  read as maintainability.
- Task generation is largely automatable; admission is not — design-pressure
  naturalness and residual leakage remain human judgments.
