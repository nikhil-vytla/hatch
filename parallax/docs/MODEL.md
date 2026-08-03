# Parallax research model

Parallax studies how agents respond when a task, its environment, or the
interaction schedule changes. The model below fixes the vocabulary for
implementations and experiments. It is a specification, not a theorem.

The SWE-bench Verified scaffold instantiates \(x_{\mathrm{pub}}\) as the issue,
repository, base commit, and pinned dataset identity. Its
\(x_{\mathrm{seal}}\) contains the official image digest, test patch,
FAIL_TO_PASS and PASS_TO_PASS tests, harness revision, and test command. The
dataset gold patch is discarded at ingestion.

## Task and environment

**Definition (TaskSpec).** A task specification is

\[
\tau = (g, c, x_{\mathrm{pub}}, x_{\mathrm{seal}}, V, R).
\]

Here \(g\) is the goal, \(c\) the task constraints,
\(x_{\mathrm{pub}}\) the inputs visible to the agent, and
\(x_{\mathrm{seal}}\) evaluator-only information. The verifier
\(V(\xi, x_{\mathrm{seal}})\) returns a verdict for trajectory \(\xi\);
\(R(\xi, x_{\mathrm{seal}})\) returns a scalar reward when an experiment needs
one. A verifier may induce reward, but verdict and reward remain distinct.

**Definition (EnvironmentSpec).** An environment specification is

\[
\varepsilon =
(\mathcal S,\mathcal O,\mathcal A,P,Z,\mu_0,H,B,\mathcal U,\kappa).
\]

\(\mathcal S,\mathcal O,\mathcal A\) are state, observation, and action spaces.
\(P(s' \mid s,a)\) gives transition dynamics, and \(Z(o \mid s)\) gives the
observation function. \(\mu_0\) is the initial-state distribution, \(H\) the
horizon, and \(B\) the resource budget. \(\mathcal U\) defines available tools
and their action semantics. \(\kappa\) is the interaction schedule, including
when user or environment events become observable.

**Definition (history, policy, trajectory).** At step \(t\),

\[
h_t=(o_0,a_0,\ldots,a_{t-1},o_t), \qquad
a_t \sim \pi(\cdot \mid h_t,\tau_{\mathrm{pub}}),
\]

where \(\tau_{\mathrm{pub}}=(g,c,x_{\mathrm{pub}})\). A run produces

\[
\xi=(s_0,o_0,a_0,s_1,o_1,\ldots,s_T,o_T), \quad T\le H.
\]

The agent never receives \(x_{\mathrm{seal}}\) unless the experiment explicitly
studies leakage.

**Invariant (authority separation).** Public task information may guide the
policy. Sealed information and verifier internals may determine evaluation but
must not enter agent-visible observations in an admitted non-leakage study.

> [!IMPORTANT]
> Verifier authority and sealed evaluator information are part of experimental
> validity. An arm that leaks or silently changes them is not comparable.

## Synthesis and admission

**Definition (synthesis strategy).** A strategy with parameters \(\theta\) and
construction randomness \(\omega\) transforms a task-environment pair:

\[
\mathcal G_{\theta}(\tau,\varepsilon;\omega)
  =(\tau',\varepsilon').
\]

This form permits changes to prompts, workspace state, dynamics, tools,
observability, budgets, or interaction timing. Synthesis is not assumed to be
text rewriting.

**Definition (perturbation).** The intervention
\(\delta=(\delta_\tau,\delta_\varepsilon,\delta_\kappa)\) records the intended
difference between source and synthesized pairs; \(\delta_\kappa\) names the
schedule component of \(\delta_\varepsilon\). Relevant axes include:

- task goal, intent, constraints, public inputs, sealed authority, verifier,
  and reward;
- initial workspace or state, transition dynamics, observability, tools,
  horizon, and budget;
- the order and timing of interaction events.

**Definition (admission).** Admission predicates
\(I_j(\tau',\varepsilon')\in\{0,1\}\) check whether a synthesized pair belongs
in an experiment. Typical checks cover schema validity, solvability, absence
of sealed leakage, verifier executability, budget compliance, and the
strategy-specific invariant.

**Invariant (verifier authority).** Unless verifier variation is the declared
intervention, all controlled arms retain the same source verifier semantics and
sealed authority:

\[
V_a \equiv V_{\mathrm{source}}
\quad\text{for every arm }a.
\]

Changing verifier authority, revealing sealed answers, or silently changing
the source population invalidates attribution. Differences in budget, tools,
dynamics, or observability are also confounds unless they are declared factors
and controlled across the relevant comparison.

## Experiments and evidence

**Definition (controlled arms).** An experiment assigns admitted,
source-matched pairs to arms \(a\in\mathcal C\). Arms share the source
distribution, verifier authority, evaluation procedure, and all non-intervened
budget and environment fields. Random seeds and construction settings are
matched or randomized according to the design.

**Definition (run evidence).** Run evidence is the retained information needed
to audit an outcome: arm assignment, source identity, admitted specifications,
agent and environment versions, observations, actions, tool results, resource
usage, verifier verdict, reward, and relevant randomness. This is a conceptual
requirement.

> [!NOTE]
> The GSM8K Evolving Intent slice represents its method-local task, intent,
> events, scripts, outcomes, design manifest, and run evidence with frozen
> strict Pydantic models and deterministic JSONL. Discriminated unions make
> event, outcome, and evidence-record variants explicit. The manifest fixes
> expected source-trial units, seeds, model configuration, arm configuration,
> and the decision threshold before outcomes are aggregated. The slice does
> not claim to implement the full abstract task and environment specifications
> defined above.

> **TODO:** Generalize only after another research journey demonstrates which
> task and environment fields need a shared executable representation.

**Estimand.** For outcome \(Y\), a basic matched-arm effect is

\[
\Delta_{a,b}
=
\mathbb E\!\left[Y(a)-Y(b)
  \mid \text{same source, admitted, controlled}\right].
\]

An implementation must state the population, assignment mechanism, outcome,
and uncertainty estimate before interpreting \(\widehat{\Delta}_{a,b}\).

**Hypothesis.** A perturbation strategy is useful when it exposes a repeatable
agent failure mode while preserving task validity and verifier authority.
Whether a particular strategy does so is an empirical question, not an
invariant.

## Strategy boundary

[Evolving Intent](methods/evolving-intent.md) is one
\(\mathcal G_\theta\): it perturbs the user-intent trajectory and interaction
schedule while restoring the source task for final evaluation. Other
strategies may transform different task or environment axes.

> [!NOTE]
> Checkpoint evolution is a separate strategy and state machine. It is not an
> Evolving Intent stage and is not specified here.

> **TODO:** Specify checkpoint-evolution states, transition guards, admission
> invariants, and controlled-arm semantics before implementing that strategy.
