# Code-quality measurement: what SCBench measures, what holds up, and what can be sealed

The paper's central claim is not a pass rate. It is that agent code
*degrades* under iteration even when tests pass. This document extracts
exactly how that is measured, what HumanLayer's independent benchmarking
found about those measurements, and how each channel maps onto Parallax's
authority model: sealed native verification, sealed deterministic
measurement, or judged outcome.

## 1. The upstream measurement stack, exactly

### 1.1 Two headline composites (paper §2.3)

**Structural erosion** is the share of the codebase's complexity mass held by
high-complexity callables:

```math
\mathrm{mass}(f) = \mathrm{CC}(f)\cdot\sqrt{\mathrm{SLOC}(f)},
\qquad
\mathrm{Erosion} =
\frac{\sum_{f\in\mathcal F} \mathbb I[\mathrm{CC}(f)>10]\cdot \mathrm{mass}(f)}
     {\sum_{f\in\mathcal F} \mathrm{mass}(f)} .
```

Cyclomatic complexity per callable, size-compressed by $\sqrt{\mathrm{SLOC}}$
"so that complexity dominates rather than pure lines of code"; the CC > 10
cutoff follows Radon's bands. Intuition: iterating agents patch logic into
already-complex functions instead of distributing it.

**Verbosity** is the fraction of lines that are redundant by rule or by clone:

```math
\mathrm{Verbosity} =
\frac{\big|\,\{\text{AST-grep flagged lines}\} \cup \{\text{clone lines}\}\,\big|}{\mathrm{LOC}}
\in [0,1],
```

with 137 targeted ast-grep rules "based on observed cases of verbose code,
best practices, and commonly cited anti-patterns," plus structural
duplication (clone lines normalized by LOC). Lines hit by multiple rules are
deduplicated before counting.

Both are computed at every checkpoint by a **pinned `scb-check` release**;
the repo records `scb_check_version` per successful measurement
(`docs/metrics-reference.md`, "Composite Scores"). No model is involved.
Missing checkpoints are excluded, not imputed (paper §2.4).

### 1.2 The wider deterministic panel (repo `docs/metrics-reference.md`)

~41 per-checkpoint metrics in `checkpoint_results.jsonl`: size (LOC, files,
symbols, lines added/removed), complexity (cc_max/mean/std, high/extreme
counts, Gini concentration, nesting), duplication (`cloned_sloc_lines`,
`cloned_pct`), decomposition (`single_use_functions`, `trivial_wrappers`,
`unused_variables`, lines per symbol), lint (`lint_errors`, `lint_per_loc`),
dependency graph (cyclic dependency mass, propagation cost, dependency
entropy), mass metrics (`mass.cc`, `mass.high_cc_pct`), and deltas
(`delta.loc`, `delta.verbosity`, `delta.churn_ratio`).

### 1.3 The LLM judge rubric: a third, separate channel

`configs/rubrics/llm_judge.jsonl` defines 45 criteria (25 typed `verbosity`,
20 typed `erosion`) across categories like `documentation_noise`,
`overengineering`, `defensive_antipatterns`, `hidden_behavior`,
`error_obscuring`. Each criterion carries a description plus positive and
negative indicators (e.g. `narration_comments` flags "# Step 1: Initialize
the list" but not "# Retry with exponential backoff to handle rate limits").
Results land in `rubric.jsonl` as per-violation records with carried-over
tracking (`rubric_carried_over`), aggregated as `rubric_total_flags`,
`rubric_per_loc` (`docs/metrics-reference.md`, "Rubric (LLM Judge)").

The paper's headline numbers use only the deterministic composites; the
rubric is present in the harness as an additional channel. Keeping these
separated is exactly the discipline Parallax needs.

### 1.4 Calibration and validity checks the authors ran

- **Human panel** (§3.3, Appendix D): 473 Python repositories, 13,667
  commits. Agent checkpoints average 0.44 verbosity / 0.68 erosion vs human
  0.19 / 0.34; agent per-checkpoint slopes 6.6× / 5.0× the human medians.
- **Sensitivity** (Appendix B.3): across nine erosion variants (cutoff 8/10/12
  × size term none/sqrt/linear), predictive correlation with next-checkpoint
  *pass rate* stays near zero (reported erosion: −0.018) while correlation
  with next-checkpoint *cost* stays positive (0.167). Plain LOC is the
  strongest raw cost predictor (0.502).

That sensitivity table matters: by the paper's own numbers, erosion does not
predict whether the next checkpoint verifies; it predicts what the next
checkpoint *costs*. Any Parallax claim built on these metrics must state
which construct it is invoking, correctness risk or effort.

## 2. What HumanLayer's benchmarking found

From `benchmarking-opus-5-on-slop-code-bench.md` (3 problems, 17 checkpoints,
Opus 4.8 / Sonnet 5 / Opus 5):

- **Rule saturation.** 89–98% of all lines written tripped at least one slop
  rule, across every model; verbosity-flagged share rose from ~65% at ck1 to
  ~80% by ck8 for all models. Their read: "some of the code quality measures
  are a bit over-aggressive." A metric near its ceiling for everyone has
  little discriminative power.
- **Low separation.** Comparing ck1→ck8 percent change across the metric
  panel, "most of the metrics don't tell the models apart", `cc_max` and
  `cloned_pct` separated models sharply; the rest clustered.
- **Style confounds.** Opus 5 wrote 5× more functions; single-use-function
  share ranged 14.9%–71.5% across models. Decomposition metrics partly
  measure architectural *style*, not quality: "lots of small functions or
  fewer big ones... I don't think any of these complexity metrics can stand
  alone."
- **Construct skepticism, with an alternative.** "I like that these measures
  are repeatable and don't use a model for judgement. But the link between
  any one of them and 'is this codebase easy to change and evolve' is not
  yet established." Their proposed better oracle is behavioral: strict pass
  under an incrementally divulged spec, and sharper still, the **handoff
  design**: have a strong model build checkpoints 1..k, then measure whether
  a weaker model can complete checkpoint k+1. The weak model's
  success and cost price the maintainability of the strong model's artifact.
- `wsff.md` supplies the theoretical frame: maintainability has no fast
  oracle, so RLVR never penalizes erosion ("there is no penalty for eroding
  codebase maintainability"); and "if a model could reliably tell good code
  from bad, it might have written the good version to begin with", the core
  argument against LLM judges as quality authority.

## 3. Parallax mapping: three authority classes

MODEL.md distinguishes sealed evaluator authority from everything else.
Quality measurement splits into three classes with different evidentiary
standing. An implementation must label every reported outcome with its class.

### Class A: native sealed verification (behavioral)

The strict verdict chain itself, and probe-based extensions of it:

- $v^{\mathrm{strict}}_i$ over accumulated obligations $\Omega_i$,
  already sealed, deterministic, and auditable. HumanLayer's argument that
  "a codebase becoming hard to maintain would lead to failing checkpoints in
  later stages" makes future strict verdicts the primary quality signal.
- **Probe cost** $Q^{\mathrm{probe}}(y_i)$: freeze $y_i$, let a fixed
  probe policy $\pi_p$ (a declared, pinned weaker agent) attempt stage
  $i+1$; record its strict verdict and resource use. This converts
  "maintainability of $y_i$" into an ordinary Parallax estimand, sealed
  authority is the stage $i{+}1$ suite; the probe is part of the
  *measurement instrument*, declared like any other environment field. Probe
  nondeterminism is handled the standard way: repeated trials, clustered
  intervals. Cost: real compute, and the measurement is relative to the
  chosen probe.

Class A is the only class that measures the *consequence* of quality rather
than a proxy for it.

### Class B: sealed deterministic measurement (static)

Erosion, verbosity, and the 41-metric panel can be sealed in the Parallax
sense, because authority can be fixed and branded:

- pin the measurement tool release and rule set; record content digests
  (`scb_check_version` is upstream's version of this. Parallax would brand
  the digest the way GSM8K answers are branded at `Problem` construction);
- measurement runs evaluator-side, never enters $x_{\mathrm{pub}}$, and is
  byte-reproducible from the retained workspace snapshot;
- verdict-like use (e.g. a quality-gate arm where $V_i$ also requires
  $\mathrm{Verbosity}(y_i)\le q$) is legitimate **only as a declared
  verifier intervention**. It changes $V$, so it can never be silently
  added to arms meant to share source verifier semantics.

Sealable is not the same as valid. Class B metrics carry three documented
limits that must sit beside any claim:

1. near-zero predictive correlation with next-stage pass (paper App. B.3);
2. ceiling effects and weak model separation (HumanLayer);
3. Goodhart exposure the moment they become reward or gate: 137 public-ish
   ast-grep rules are a finite, learnable target, and HumanLayer notes it is
   "easy for a model to reward hack any of them."

So Class B outcomes are reported as *measurements with pinned authority*,
usable for slope estimands, but claims about "maintainability" from Class B
alone are out of bounds; the licensed constructs are "rule-flagged
redundancy" and "complexity concentration," plus the cost-prediction link
the paper actually established.

### Class C: judged outcomes (cannot be sealed)

The LLM rubric is not sealable: its authority is a model, whose behavior is
not a fixed function of retained inputs. Two failure modes are structural,
not incidental: judge drift across model versions, and the wsff circularity
(the judge shares training lineage and taste with the agents it judges,
correlated measurement error across arms, in the worst case favoring
same-family agents).

Parallax standing for Class C:

- labeled `judged`, never `verification`; excluded from admission gates and
  from any primary estimand;
- admissible as a *secondary, audited* channel only with: pinned judge model
  and prompt digest, retained full judge transcripts, fixed rubric
  (`llm_judge.jsonl`-style, with positive/negative indicators), repeated
  judgments with reported agreement, and, when feasible, human
  spot-audit of a sample with disagreement rates reported beside every
  judged number;
- a judged outcome can *motivate* a Class A probe design, never substitute
  for one.

### Summary table

| Channel | Authority | Sealed? | Parallax label | Primary use |
| --- | --- | --- | --- | --- |
| Strict/ISO/core verdicts over $\Omega_i$ | pinned test suites, entrypoint-only | yes | Verification | correctness estimands |
| Future-stage verdicts, probe success/cost | stage suites + pinned probe policy | yes | Verification (probe-relative) | behavioral quality estimands |
| Erosion, verbosity, 41-metric panel | pinned `scb-check`-equivalent digest | yes | sealed measurement | slope estimands; cost prediction |
| Quality thresholds inside $V_i$ | as above, but verdict-inducing | yes | declared verifier intervention | Goodhart / backpressure experiments only |
| LLM rubric flags | pinned judge model + rubric | no | judged outcome | secondary, audited; hypothesis generation |

> Claim limit: class assignments are design commitments, not results. No
> Parallax measurement of any class has been executed for this method; the
> empirical properties cited are the paper's and HumanLayer's, under their
> setups.
