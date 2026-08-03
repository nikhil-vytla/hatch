# Checkpoint evolution from SloP Code Bench: method design for Parallax

This folder designs Parallax's second synthesis method — **checkpoint
evolution** — from SlopCodeBench
([arXiv:2603.24755](https://arxiv.org/abs/2603.24755);
[SprocketLab/slop-code-bench](https://github.com/SprocketLab/slop-code-bench)
at commit `8e3a8b69`), expressed in the vocabulary of
`parallax/docs/MODEL.md`. It is documentation and formal modeling only; no
implementation code.

## Contents

| File | Deliverable |
| --- | --- |
| [`algorithmic-model.md`](algorithmic-model.md) | Formal model: persistent state, per-checkpoint task tuple, sealed obligation accumulation, evolution operators, state machine, estimands, matched arms |
| [`quality-measurement.md`](quality-measurement.md) | Exact extraction of the paper's quality metrics, HumanLayer's findings about them, and the sealed / judged authority classification |
| [`research-questions.md`](research-questions.md) | Eight falsifiable RQs unavailable to Evolving Intent, with estimands |
| [`synthesis-workflow.md`](synthesis-workflow.md) | Repeatable synthesis pipeline, admission gates G1–G6, Cursor skill specs, automation boundary |
| [`checkpoint-evolution.md`](checkpoint-evolution.md) | Draft method doc for `parallax/docs/methods/`, marked proposed/not-implemented |
| [`NOTES.md`](NOTES.md) | Working notes and source characterization |

## Key algorithmic insights

**1. Checkpoint evolution is the structural dual of Evolving Intent.**
Evolving Intent perturbs the intent schedule *within* one episode and ends
with terminal restoration — the source verifier, sealed answer, and task are
recovered exactly, and nothing the agent did persists. Checkpoint evolution
perturbs *across* episodes and never restores: the agent's own terminal
workspace is the next stage's initial state (\(\mu_{0,i+1} =
\delta_{W_i}\)), and sealed authority accumulates monotonically
(\(\Omega_i = \Omega_{i-1}\cup T_i\)) instead of being restored. The
integrity invariant dual to terminal restoration is **non-destructive
accumulation**: no checkpoint may invalidate a prior sealed test. That single
substitution — restore-the-end vs never-invalidate-the-past — generates the
whole method.

**2. The artifact is the only channel, so persistence is analyzable.** The
benchmark resets everything between checkpoints except the working directory
(fresh container, no conversation carry-over). Persistent state is exactly
\(W_i = (\text{workspace}, \text{dependency manifest})\) on the agent side
and \(\Omega_i\) on the evaluator side, and neither crosses the authority
boundary. This makes the method's causal claim crisp: any cross-stage effect
is mediated by the code the agent wrote.

**3. Refactoring pressure is a property of the operator sequence, not an
operator.** Checkpoint deltas come from a closed set (extension, refinement,
input-source generalization, re-modality); what makes a sequence a *design*
test is that a myopic-but-correct architecture at stage 1 pays a measurable
downstream price. That property — which the paper asserts per-problem by
author judgment — can be operationalized as a churn/cost ratio between naive
and anticipatory reference builds, which turns it into an admission gate
(G4) instead of a matter of taste.

**4. "Maintainability" gets a native, sealed, behavioral price.** The future
stages themselves — and probe variants (freeze \(y_i\), let a pinned weaker
agent attempt stage \(i+1\)) — price the quality of today's artifact in
verification and cost, with sealed authority. Static quality composites
(erosion, verbosity) are sealable as pinned deterministic measurements but
carry documented validity limits: the paper's own sensitivity analysis shows
erosion has near-zero correlation with next-checkpoint pass (−0.018) while
predicting cost (+0.167), and HumanLayer found 89–98% of all agent lines
trip at least one rule. The LLM rubric channel cannot be sealed at all and
must be labeled a judged outcome. The three-class split (native
verification / sealed measurement / judged) is the method's measurement
policy.

## Strongest three research questions

1. **Self-accumulation (RQ1).** Does building on one's *own* artifact —
   versus a correctness-matched reference artifact — cause later-stage
   verification failure? This is the causal mechanism the entire benchmark
   asserts but never controls for; the `carry-reference` arm is the missing
   matched control, and any result is informative.
2. **Probe validity of static quality (RQ5).** Do sealed static metrics
   predict the behavioral price of an artifact better than a pinned probe
   agent does? This adjudicates the live dispute between the paper's
   metrics-based evidence and HumanLayer's behavioral-oracle position, and
   its answer sets Parallax's measurement policy for every subsequent
   checkpoint-evolution experiment.
3. **Context discipline and the slope (RQ3).** Does a persistent design
   artifact (wsff-style program design carried as declared public input
   across stages) change the degradation *slope*, where prompt-only
   interventions demonstrably change only the intercept? This converts the
   most influential practitioner claim in the space — that quality decay is
   a training problem no harness fixes — into a matched-arm slope estimand.

## Honest assessment: agent-assisted vs hand-authored task quality

The case for parity is stronger than expected going in. Upstream's
hand-authoring process is mostly checklist-shaped (the repo publishes the
checklists), and its one genuinely judgmental filter — "does this
meaningfully test design decisions?" — is operationalizable as a measured
churn ratio (gate G4) that is arguably *more* rigorous than author
intuition. The hand-authored baseline is also not defect-free:
`KNOWN_ISSUES.md` records defective reference solutions on 5 of 36 problems
at release, and the dual-incremental-reference gate (G1/G3) is specifically
designed to beat that rate.

The honest residual doubt sits in seed taste and roadmap naturalness. The
paper's problems are credible because the authors knew their seed domains
deeply; a generated family can pass every mechanical gate and still be a
sterile puzzle whose "evolution" no real product would undergo. That risk is
not automatable away today — it is a construct-validity judgment with no
computable oracle — which is why the workflow keeps humans at exactly two
points (design-pressure naturalness, residual semantic leakage) and treats
generation as automatable but **admission as where honesty lives**.

Evidence that would settle it: author \(k\) families through the pipeline,
take \(k\) matched hand-authored SCBench problems, run the same pinned agent
panel on both, and compare model-ranking agreement, strict-rate headroom,
degradation-slope distributions, post-freeze defect rates, and blind expert
spec review. Ranking agreement with comparable headroom and no excess defect
rate is the match criterion; divergence localizes which pipeline stage loses
fidelity.

## Sources

- Paper: [SlopCodeBench (arXiv:2603.24755)](https://arxiv.org/abs/2603.24755)
- Repo: [SprocketLab/slop-code-bench](https://github.com/SprocketLab/slop-code-bench)
  @ `8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b` (docs/contributing-problems,
  docs/evaluation, docs/metrics-reference.md, configs/rubrics)
- HumanLayer: [Benchmarking Opus 5 on SlopCodeBench](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/benchmarking-opus-5-on-slop-code-bench.md),
  [Why Software Factories Fail](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md)
- Parallax: `parallax/docs/MODEL.md`, `parallax/docs/methods/evolving-intent.md`

No implementation code was written and `parallax/` sources are untouched;
the draft method doc ships in this folder pending review.
