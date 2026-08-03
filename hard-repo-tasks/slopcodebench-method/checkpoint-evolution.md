# Checkpoint Evolution method

> [!IMPORTANT]
> This method is proposed and not implemented. No Parallax slice, admission
> gate, or run evidence exists for it. Every definition below is a
> specification target, not a description of executable behavior.
>
> This document is drafted for `parallax/docs/methods/checkpoint-evolution.md`
> and currently lives in `hard-repo-tasks/slopcodebench-method/`.

Checkpoint Evolution is a synthesis strategy \(\mathcal G_{\mathrm{CE}}\) in
the [Parallax research model](../MODEL.md). It perturbs the initial workspace
state and the cross-episode requirement-disclosure schedule: an agent
repeatedly extends its own prior artifact under an evolving specification,
while sealed evaluator authority accumulates monotonically. It is a separate
strategy and state machine from Evolving Intent, not an Evolving Intent
stage.

## References

The method comes from Orlanski, Roy, Yun, Shin, Gu, Ge, Adila, Roberts,
Sala, and Albarghouthi,
["SlopCodeBench: Benchmarking How Coding Agents Degrade Over Long-Horizon Iterative Tasks"](https://arxiv.org/abs/2603.24755),
arXiv:2603.24755 (2026).

Implementation guidance was checked against the
[SprocketLab slop-code-bench repository at commit `8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b`](https://github.com/SprocketLab/slop-code-bench/tree/8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b)
on 2026-08-02, in particular `docs/contributing-problems/`,
`docs/evaluation/architecture.md`, and `docs/metrics-reference.md`. Parallax
would be an independent implementation and does not depend on that
repository.

Measurement critique was checked against HumanLayer's
[benchmarking notes](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/benchmarking-opus-5-on-slop-code-bench.md)
and
["Why Software Factories Fail"](https://github.com/humanlayer/advanced-context-engineering-for-coding-agents/blob/main/wsff.md).

## Strategy

Let \(\sigma\) be an admitted seed with a checkpoint family plan of length
\(n\).

**Definition (family).** The strategy emits an ordered family of task pairs
\([(\tau_1,\varepsilon_1),\ldots,(\tau_n,\varepsilon_n)]\) coupled through
persistent agent state.

**Definition (persistent state and obligations).** Agent-side state
\(W_i = (y_i, d_i)\) carries the produced workspace and dependency manifest;
nothing else persists between stages — no conversation, no tool state, no
evaluator feedback. Evaluator-side obligations accumulate as
\(\Omega_i = \Omega_{i-1} \cup T_i\), \(\Omega_0 = \varnothing\), where
\(T_i\) is stage \(i\)'s sealed test set.

**Definition (stage tuple).** Stage \(i\) is
\(\tau_i = (g_i, c, S_i, (T_i, \Omega_{i-1}, N_i), V_i, R_i)\) with \(c\)
the fixed external-contract constraint (entrypoint-only observability, no
prescribed internals), \(S_i\) the public specification, \(N_i\) sealed
normalization rules, and

\[
V_i(y_i) = \Big(\bigwedge_{t\in\Omega_i} t(y_i),\;
               \bigwedge_{t\in T_i} t(y_i),\;
               \bigwedge_{t\in T^{\mathrm{core}}_i} t(y_i)\Big)
\]

the strict, isolated, and core verdicts. The environment
\(\varepsilon_i\) is a fresh sandbox with
\(\mu_{0,i} = \delta_{W_{i-1}}\) and a single specification delivery at
episode start.

**Definition (evolution operators).** Stage transitions
\(S_{i-1}\mapsto S_i\) come from a closed operator set: extension (new
behavior on new input domain, old behavior preserved), refinement (behavior
pinned on a previously unconstrained subdomain), input-source
generalization, and re-modality (declared contract morphism). Refactoring
pressure is a property of the operator sequence, admitted via a measured
churn ratio between naive and anticipatory reference builds, not an
operator.

**Invariant (non-destructive accumulation).** For all \(i<j\), every test in
\(\Omega_i\) remains in force and semantically valid at stage \(j\). This is
the Checkpoint Evolution counterpart of Evolving Intent's terminal
restoration: Evolving Intent restores the source task at the end; Checkpoint
Evolution never invalidates the past. Dropping inherited obligations is a
declared verifier intervention, never a silent default.

**Invariant (workspace fidelity).** \(\mu_{0,i+1}\) equals the agent's own
terminal \(W_i\) exactly — no repair or reference substitution. Substituting
a reference workspace severs the causal chain from early decisions to later
outcomes and is only permitted as the declared `carry-reference` control
arm.

**Invariant (authority separation).** Sealed suites, verdicts, and
evaluator-side measurements never enter public inputs or observations at any
stage. Because episodes share only \(W\), it suffices that no evaluator
output is ever written into the workspace.

**Definition (outcome classification).** Test failures are Verification
outcomes; container, provider, budget-infrastructure, and verifier-runtime
faults are RunFailures. A failing verdict never halts a family (the flawed
workspace carries forward by design); a missing workspace censors remaining
stages, which are recorded and bounded worst-case, not dropped.

## Quality measurement classes

Correctness verdicts and probe outcomes (a pinned probe policy attempting
stage \(i{+}1\) on a frozen \(y_i\)) are native sealed verification. Static
composites — structural erosion and verbosity per the paper's §2.3
definitions, plus the wider deterministic panel — are sealed measurements
when the measuring tool release and rule set are pinned and digest-branded;
they support slope estimands but not maintainability claims on their own.
Rubric-based LLM judgments cannot be sealed and are labeled judged outcomes:
secondary, transcript-retained, agreement-audited, excluded from admission
and from primary estimands.

> [!WARNING]
> The paper's own sensitivity analysis reports near-zero predictive
> correlation between erosion and next-checkpoint pass rate, and independent
> benchmarking found 89–98% of agent-written lines trip at least one
> verbosity rule. Sealed static quality scores are evidence about
> rule-flagged redundancy and complexity concentration, not established
> proxies for maintainability.

## Controlled comparison

**Invariant (matched authority and budget).** All arms share the family's
sealed suites, obligation accumulation, normalization, agent configuration,
and declared per-stage budgets. Arms differ only in the named intervention:
initial-workspace source (`evolved` vs `carry-reference`), disclosure
schedule (`evolved` vs `monolithic` vs `foresight`), or declared schedule
insertions (`repair-scheduled`). A quality threshold inside \(V_i\) is a
verifier intervention and cannot be combined silently with any other
contrast.

**Hypothesis.** Iterative extension of an agent's own artifact can expose
compounding failure modes — verification decay and quality degradation —
that matched single-episode or reference-workspace presentations of the same
requirements do not. The effect is an empirical estimand under the
controlled-arm rules in `MODEL.md`, not a property assumed by construction.

## Required behavioral coverage

An implementation requires Parallax-owned regression coverage for:

- family compilation from an admitted plan: operator labeling, first-stage
  core-problem immutability, non-destructive sequencing;
- obligation accumulation and automatic regression reclassification of
  prior-stage tests;
- workspace carry-forward fidelity, including environment reset of
  everything outside \(W\);
- entrypoint-only verifier execution and the strict/isolated/core verdict
  vector;
- RunFailure vs Verification classification and censoring of missing
  workspaces with worst-case bounds;
- pinned, digest-branded static quality measurement with retained workspace
  snapshots;
- matched-arm construction for each declared intervention, including budget
  matching for `monolithic` and `repair-scheduled`;
- admission gates: dual incremental gold references, per-stage no-op
  failure, mutant and cross-implementation ambiguity checks, churn-ratio
  design pressure, leakage lint, and headroom calibration.

These are semantic contracts. They do not require byte parity with the
consulted repository's runner.

## Interpretation and limits

Where the paper leaves behavior open, a Parallax adapter must document its
interpretation. Known open points from the consulted sources: the upstream
`include_prior_tests: false` escape hatch (treated here as a declared
verifier change), the paper's zero-scoring of unreached checkpoints (treated
here as censoring with bounds), and re-modality's effect on inherited
obligations (treated here as a declared contract morphism requiring explicit
obligation mapping).

> [!IMPORTANT]
> Every intentional difference from the consulted benchmark requires an
> explicit rationale and behavioral regression coverage once an
> implementation exists.

The upstream problem set is public, and its sealed suites target the Python
track in evaluation despite language-agnostic specifications. Parallax
families synthesized under the workflow in the accompanying documents are
new constructions; no claim of upstream score reproduction is available or
intended.

> **TODO:** Before implementation, freeze the first-slice choices: seed
> class, family length, probe policy, quality-measurement pinning, and the
> initial pair of controlled arms (`evolved` vs `carry-reference` is the
> recommended first contrast).
