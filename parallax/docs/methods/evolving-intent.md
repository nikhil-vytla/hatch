# Evolving Intent method

Evolving Intent is one synthesis strategy
\(\mathcal G_{\mathrm{EI}}\) in the [Parallax research
model](../MODEL.md). It perturbs a task's user-intent trajectory and interaction
schedule. It is not the Parallax architecture.

## References

The method comes from Tack, Laban, and Neville,
["LLMs Get Lost in Evolving User Intent"](https://arxiv.org/abs/2607.20734v1),
arXiv:2607.20734v1 (2026).

Implementation guidance was checked against the
[Microsoft Evolving Intent repository at commit `993d6be9597ac03854b46362ccd647eb1bfd267a`](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a)
on 2026-08-02. Parallax is an independent implementation and does not depend
on that repository.

## Strategy

Let \((\tau^\star,\varepsilon^\star)\) be a verifiable source pair, with source
answer \(y^\star\) held by verifier authority \(V^\star\).

**Definition (extraction).** Extract source intent as a function and arguments:

\[
E(\tau^\star_{\mathrm{pub}})
  = I^\star
  = (f^\star,\alpha^\star),
\qquad
\alpha^\star=(a_1^\star,\ldots,a_m^\star).
\]

**Definition (argument counterfactuals).** For each eligible argument \(j\),
construct accepted alternatives
\(C_j=\{a_{j,1}',\ldots,a_{j,n_j}'\}\). Each alternative changes that argument
without changing the evaluator's authority over the source task.

**Definition (predecessor chain).** Construct functions from an earlier intent
toward the source:

\[
f_{-k}\rightarrow f_{-(k-1)}\rightarrow\cdots\rightarrow f_{-1}
\rightarrow f^\star.
\]

Each predecessor is conditioned on its immediate successor and the arguments
needed to make that transition coherent. Construction may escalate to a
fallback model after a declared number of failed attempts. Fallback escalation
is a construction policy, not an agent-visible event.

**Definition (intent trajectory).** At user turn \(t\), let

\[
z_t=(f_t,v_t,r_t)
\]

contain the active function, active argument values, and revealed argument
identifiers. The trajectory
\(\zeta=(z_0,\ldots,z_T)\) advances through predecessor functions,
counterfactual values, corrections, and reveals.

**Invariant (terminal restoration).**

\[
z_T=(f^\star,\alpha^\star,\{1,\ldots,m\}),
\qquad
V_{\mathrm{EI}}\equiv V^\star,
\qquad
y_{\mathrm{target}}=y^\star.
\]

The conversation may evolve, but final evaluation retains the source verifier,
sealed authority, and answer.

**Definition (schedule and rendering).** Function changes, corrections, and
reveals form an event set \(\mathcal E\) with dependency relation \(\prec\).
A schedule is a turn assignment that is a linear extension of
\((\mathcal E,\prec)\): predecessor phases move toward \(f^\star\), events occur
under their owning function phase, and source restoration is terminal. The
renderer maps scheduled state deltas to user messages. When several deltas
share a turn, the consulted implementation renders function change, correction,
then reveals.

Benchmark overlays may refine ownership or argument ordering without changing
terminal restoration or verifier authority.

## Controlled comparison

**Invariant (matched authority and budget).** Static, matched, and evolving
arms use the same source-task distribution, \(V^\star\), sealed evaluator
information, agent configuration, and declared resource budget. A matched
control should equalize interaction length or exposed information according to
the experiment design. Any remaining arm difference must be named as an
intervention.

**Hypothesis.** An evolving trajectory can expose failures that a static or
matched presentation of the same verifiable task does not. The effect is an
empirical estimand under the controlled-arm rules in `MODEL.md`, not a property
assumed by construction.

## PR3 behavioral contracts

PR3 must add Parallax-owned tests for:

- extraction of source function and arguments;
- argument counterfactual acceptance and selection;
- immediate-successor predecessor conditioning and declared fallback
  escalation;
- trajectory states and transitions;
- dependency-respecting scheduling and deterministic rendering under fixed
  local inputs;
- terminal restoration of source function, arguments, reveals, answer, and
  verifier authority;
- matched arm and budget construction;
- benchmark-specific overlay behavior where an adapter uses one.

These are semantic contracts. They do not require provider-text or byte parity
with the consulted repository.

## Interpretation and limits

Where the paper leaves behavior open, a Parallax adapter must document its
interpretation. Any intentional difference from the consulted implementation
must be explicit and covered by a PR3 behavioral test.

Two details may affect future adapters. BIRD-SQL construction uses global
shuffling, multiple workers, and completion-order collection, so a seed alone
does not define output order. The consulted SWE overlay strips symptom
arguments before scheduling and reinserts them later; its final category sort
can place symptoms after recognized categories.

The upstream generated pools and provider transcripts are not published in the
repository. Parallax therefore makes no claim of byte-identical dataset
reproduction, provider replay, or paper-score reproduction. This PR introduces
no runtime implementation or test suite.
