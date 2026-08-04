# Research questions enabled by checkpoint evolution

Each question is falsifiable, names its estimand in the vocabulary of
`algorithmic-model.md` (§2.7 arms and estimands), and is *structurally
unavailable* to Evolving Intent, which restores the source task at terminal
evaluation and never lets agent output persist across episodes.

Notation: $Y_i$ = strict verdict at stage $i$; $Q_i$ = a Class B
quality measurement (declared per experiment); $\beta$ = per-stage quality
slope; arms as defined in the algorithmic model.

---

**RQ1 — Self-accumulation.** *Does building on one's own artifact — rather
than a correctness-matched reference artifact — cause later-stage
verification failure?*

Estimand: $\Delta_{\mathrm{evolved},\,\mathrm{carry\text{-}reference}}(i)$
on $Y_i$, for $i \ge 2$, family-clustered.
Falsified if the contrast is ≈ 0: then degradation reported by the paper is
driven by requirement growth, not by self-conditioning, and the benchmark's
core causal narrative ("the agent never pays the cost of its own early
design decisions" in other benchmarks) loses its teeth. The paper asserts
this mechanism but never runs the matched control; this is the single
highest-value experiment in the design space.

**RQ2 — Silent degradation.** *Does quality degrade across stages even
conditional on sustained strict correctness?*

Estimand: $\mathbb E[Q_{i+1}-Q_i \mid Y_1=\cdots=Y_i=1]$ vs the
unconditional slope. The paper reports 77%/75.5% of trajectories rising in
erosion/verbosity but never conditions on correctness (§3.2); with strict
pass at 14.8%, its slopes are dominated by already-failing trajectories.
Falsified if the conditional slope is ≈ 0 — then "slop" is a symptom of
being lost, not a tax paid by successful agents, which inverts the
interpretation.

**RQ3 — Context discipline and the slope.** *Do wsff-style persistent design
artifacts change the degradation slope, or only the intercept?*

Intervention: an arm where a frozen architecture/program-design document
(produced at stage 1, agent- or human-authored, declared as public input)
is appended to $x_{\mathrm{pub},i}$ at every stage. Contrast with the
prompt-only interventions the paper tested, which moved $Q_1$ by up to
62.3% but left the slope at ~1.3 pp/checkpoint (§3.4). Estimand:
$\Delta^{\beta}$ between artifact arm and just-solve arm, plus the
$Y_i$ contrast to price the correctness cost.
Falsified if $\Delta^{\beta}\approx 0$: degradation is then not a
context/steering problem, supporting wsff's stronger claim that it is a
training-signal problem no harness fixes.

**RQ4 — Granularity vs requirement mass.** *Holding the terminal
specification fixed, does finer checkpoint partitioning cause more
degradation?*

Design: one seed compiled at $n \in \{2, 4, 8\}$ partitions of the same
final spec, matched total budget. Estimands: terminal $Q_n$ and terminal
strict verification vs $n$; slope vs per-stage requirement mass.
Falsified if terminal outcomes are flat in $n$: iteration count per se is
then harmless, and degradation loads on total requirement mass — which would
also say monolithic single-shot evaluation was never the blind spot the
iterative-benchmark movement claims.

**RQ5 — Probe validity of static quality.** *Do sealed static metrics
predict the behavioral price of the artifact better than chance, and better
or worse than a probe agent does?*

Design: at each stage freeze $y_i$; measure $Q_i$ (Class B) and
$Q^{\mathrm{probe}}_i$ (pinned weaker agent attempts stage $i+1$;
Class A). Compare their predictive power for the treatment agent's own
$Y_{i+1}$ and cost. The paper's own Appendix B.3 (erosion ↛ next-stage
pass, erosion → next-stage cost) plus HumanLayer's handoff proposal make
this a live three-way race.
Falsifiable both ways: if $Q_i$ predicts nothing the probe doesn't, Class B
metrics can be dropped from primary reporting; if $Q_i$ matches the probe,
Parallax saves the probe compute.

**RQ6 — The price of the unknown future.** *Does disclosing the full roadmap
at stage 1 eliminate degradation while iteration continues?*

Estimand: $\Delta_{\mathrm{foresight},\,\mathrm{evolved}}(i)$ on both
$Y_i$ and $\beta$. The paper's premise is that unknown future
requirements force architectural bets; foresight removes the uncertainty but
keeps the iteration. Falsified if foresight doesn't help: then degradation
is not about anticipating requirements at all, but about the mechanics of
repeated self-editing — a materially different failure mode with different
training implications.

**RQ7 — Reversibility.** *Can a declared refactor-only stage (no new
requirements, $T_{\mathrm{new}}=\varnothing$, sealed suite unchanged)
recover subsequent verification or flatten the slope?*

Estimand: $\Delta_{\mathrm{repair\text{-}scheduled},\,\mathrm{evolved}}$
on post-repair $Y_j$ and $\beta$, budget-matched (repair stages consume
budget the control spends on regular stages).
Falsified if repair stages buy nothing: degradation would then be effectively
irreversible by the agent that caused it — strong evidence for the wsff
position that the same model cannot judge or fix its own quality debt.

**RQ8 — Goodhart under sealed quality gates.** *When a Class B quality
threshold is added to the verifier (declared intervention), do agents
satisfy the letter of the metric while quality-adjacent behavior worsens?*

Design: gate arm with $V_i$ requiring $\mathrm{Verbosity}(y_i)\le q$;
measure the gated metric, the *held-out* metric family (ungated Class B
metrics + probe cost), and correctness. The paper found prompt-level quality
pressure costs 2.4–3.6 pp strict (§3.4); a verdict-level gate is the
sharper intervention.
Falsified if gated and held-out quality move together with no correctness
loss — that would be genuine (and surprising) evidence that cheap static
gates are safe backpressure, contra HumanLayer's reward-hacking expectation.

---

## The strongest three

1. **RQ1** — it tests the causal mechanism the entire benchmark is built on,
   with a control upstream deliberately omitted. Any result is informative.
2. **RQ5** — it adjudicates the live dispute between the paper (static
   metrics as degradation evidence) and HumanLayer (behavioral probes as the
   only trustworthy oracle), and its outcome determines Parallax's own
   measurement policy for every later CE experiment.
3. **RQ3** — it converts the most influential practitioner claim in this
   space (wsff: "no amount of harness engineering can solve a model-training
   issue") into a matched-arm test with a clean slope estimand.

> Claim limit: no RQ has been run. Expected directions cited from the paper
> and HumanLayer are their findings under their setups, not Parallax
> evidence.
