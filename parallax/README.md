# Parallax

Parallax is a research harness for identifying modern-agent failure modes,
turning them into research questions about agent training and RL environments,
synthesizing novel or harder but verifiable tasks from existing benchmarks and
codebases, and running controlled experiments with trustworthy evidence.

The old research branch is not being merged wholesale. It combines useful
historical evidence with prototypes, hand-authored pseudo-Evolving-Intent
behavior, and incomplete verifier identity. Parallax is being rebuilt as a
small reviewable sequence:

1. define the shared research model and Evolving Intent strategy
2. add a content-addressed domain and native-verifier core
3. implement real GSM8K Evolving Intent behavior with Parallax-owned tests
4. add a controlled experiment runner

This first PR covers step 1 only. [`docs/MODEL.md`](docs/MODEL.md) defines the
task, environment, synthesis, admission, controlled-arm, evidence, and estimand
vocabulary used by later code.

[`docs/methods/evolving-intent.md`](docs/methods/evolving-intent.md) defines
Evolving Intent as one strategy in that model and records the published method,
source links, interpretation policy, and evidence limits. This PR adds no
runtime implementation, behavioral tests, generated benchmark pool, provider
transcript, or paper-score reproduction.
