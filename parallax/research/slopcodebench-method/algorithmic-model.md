# Checkpoint evolution: algorithmic model

This document formalizes checkpoint evolution — the synthesis strategy behind
SlopCodeBench (SCBench) — in the vocabulary of Parallax's
[`docs/MODEL.md`](../../docs/MODEL.md). It characterizes what the
paper and repository actually do before abstracting, and cites the specific
sections and files each claim comes from.

Primary sources:

- Orlanski et al., "SlopCodeBench: Benchmarking How Coding Agents Degrade Over
  Long-Horizon Iterative Tasks", [arXiv:2603.24755](https://arxiv.org/abs/2603.24755).
- [SprocketLab/slop-code-bench](https://github.com/SprocketLab/slop-code-bench)
  at commit `8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b` (consulted 2026-08-02).

## 1. What the upstream benchmark actually does

Characterization first; abstraction in §2.

**Task formulation (paper §2.2).** A problem \(P\) is an ordered list of
checkpoints \([C_1,\ldots,C_n]\), \(n \in [3,8]\). At \(C_i\) the agent
\(\pi_\theta\) receives only the specification text \(x_i\) and its own prior
workspace \(y_{i-1}\), and produces \(y_i = \pi_\theta(x_i, y_{i-1})\), with
\(y_0\) the empty workspace. The paper is explicit that the causal chain is the
point: "If a reference solution replaces the agent's code between turns, the
causal chain from early decisions to later degradation is removed."

**Episode isolation (paper §3, Setup).** Each checkpoint runs in a fresh
Docker container as a non-root user; only the working directory persists.
Installed packages, shell history, and agent session data reset between
checkpoints. There is no conversation carry-over: "The agent must reason about
changes solely from the code's current structure, as we do not provide the
prior conversation's context." So the *only* channel by which stage \(i\)
influences stage \(i+1\) is the artifact itself.

**Design principles (paper §2.1; repo `docs/contributing-problems/README.md`).**

1. No prescribed internal interfaces — specs constrain the external contract
   only (entry command, CLI flags, API endpoints, output schemas).
2. No visible test suite — agents see specification prose and embedded
   examples, never tests or test feedback.
3. Black-box, language-agnostic evaluation via subprocess/API, with
   normalization guidance (ordering, tie-breaking, path format) wherever an
   arbitrary implementation choice could cause a false failure.

**Evaluation (paper §2.4; repo `docs/evaluation/architecture.md`).** Hidden
pytest suites interact with the solution only through the entrypoint. Tests
are categorized Core (unmarked), Error, Functionality, and Regression, where
regression is *all tests from prior checkpoints*, re-classified automatically
by the runner regardless of their original markers (`_determine_group_type`,
Rule 1). \(C_1\) has no regression tests. Three verdicts per checkpoint:
strict (all tests including regression), ISO (all non-regression), CORE (core
only). If the agent crashes mid-problem, remaining checkpoints score zero
correctness; quality metrics for missing checkpoints are excluded, not
imputed. Pytest exit codes 2–5 are flagged `infrastructure_failure` and are
distinguished from test failures — the upstream analog of Parallax's
Verification vs RunFailure split.

**Checkpoint semantics (repo `docs/contributing-problems/README.md`).**
Sanctioned checkpoint moves: expand constraints, narrow constraints, modify
input source, change modality (CLI → REST). Prohibited: changing the core
problem, adding unrelated problems, removing previously working features
(`review-checklist.md`: "Each checkpoint adds to prior ones — no removal of
previously working features"). The first checkpoint defines the core problem
and "you can't change it later."

## 2. Formal model

### 2.1 The strategy

Checkpoint evolution is a synthesis strategy \(\mathcal G_{\mathrm{CE}}\) in
the sense of MODEL.md, but with an output shape MODEL.md's single-pair form
does not capture: it emits an ordered *family* of admitted task–environment
pairs coupled through persistent state,

\[
\mathcal G_{\mathrm{CE}}(\sigma;\theta,\omega)
  = \big[(\tau_1,\varepsilon_1),\ldots,(\tau_n,\varepsilon_n)\big],
\]

where \(\sigma\) is a source seed (a repository, tool, or existing benchmark
task family that admits checkpoint decomposition) and the coupling constraint
is that \(\varepsilon_{i+1}\)'s initial state is a deterministic function of
the *agent's own* terminal state under \(\tau_i\). The perturbation
\(\delta\) of checkpoint evolution is primarily
\(\delta_\varepsilon\) (initial workspace state) and \(\delta_\kappa\)
(information about the goal is scheduled across episodes rather than within
one); the sealed authority grows monotonically rather than being restored.

This is the structural dual of Evolving Intent. EI perturbs the intent
trajectory *within* one episode and ends with terminal restoration
(\(V_{\mathrm{EI}} \equiv V^\star\), same sealed answer). CE perturbs *across*
episodes and never restores; its integrity invariant is instead
**non-destructive accumulation** (§2.5).

### 2.2 Persistent state

The state that survives between checkpoints is deliberately minimal:

\[
W_i = (y_i, d_i),
\]

where \(y_i\) is the workspace (file tree) the agent produced at stage \(i\)
and \(d_i\) is the declared dependency manifest (upstream: the venv and
`requirements.txt` the prompts instruct the agent to maintain; repo
`configs/prompts/just-solve.jinja`). Explicitly *not* persistent: conversation
history, tool state, installed system packages, and any evaluator feedback.
The agent never observes verdicts, so \(W_i\) contains no information about
the sealed suite.

Alongside \(W_i\), the *evaluator* accumulates the regression obligation set

\[
\Omega_i = \Omega_{i-1} \cup T_i, \qquad \Omega_0 = \varnothing,
\]

where \(T_i\) is checkpoint \(i\)'s sealed test set. \(\Omega\) lives entirely
on the sealed side; it is persistent evaluator state, dual to the persistent
agent state \(W\). Both persist, neither crosses the authority boundary.

### 2.3 Per-checkpoint task tuple

Each stage is a TaskSpec in MODEL.md's form:

\[
\tau_i = (g_i,\; c,\; x_{\mathrm{pub},i},\; x_{\mathrm{seal},i},\; V_i,\; R_i)
\]

- \(g_i\): satisfy specification \(S_i\), which extends the observable
  behavior of the artifact.
- \(c\): the external-contract constraint, fixed across the family: behavior
  is exercised only at the declared entrypoint (CLI arguments, API
  endpoints); internal structure is unconstrained. This constraint is what
  transfers the architectural burden to the agent.
- \(x_{\mathrm{pub},i} = S_i\): specification prose plus embedded examples
  and normalization guidance. Nothing else — no tests, no verdicts, no prior
  conversation.
- \(x_{\mathrm{seal},i} = (T_i, \Omega_{i-1}, N_i)\): the new sealed tests,
  the inherited obligations, and the normalization/comparison rules the
  harness applies. Sealed information *accumulates*; this is the main
  departure from single-shot TaskSpecs.
- \(V_i\): executes \(\Omega_i = \Omega_{i-1}\cup T_i\) against the
  entrypoint of the produced workspace \(y_i\) and returns the verdict vector

\[
V_i(y_i)
  = \big(v^{\mathrm{strict}}_i,\; v^{\mathrm{iso}}_i,\; v^{\mathrm{core}}_i\big),
\quad
v^{\mathrm{strict}}_i = \!\!\bigwedge_{t \in \Omega_i}\!\! t(y_i),
\quad
v^{\mathrm{iso}}_i = \!\!\bigwedge_{t \in T_i}\!\! t(y_i),
\quad
v^{\mathrm{core}}_i = \!\!\bigwedge_{t \in T_i^{\mathrm{core}}}\!\! t(y_i).
\]

- \(R_i\): when an experiment needs a scalar, the natural choice is
  \(\mathbb I[v^{\mathrm{strict}}_i]\); quality measurements are separate
  outcome channels, not reward (see `quality-measurement.md`).

The environment \(\varepsilon_i\) is a fresh sandbox whose initial-state
distribution is degenerate at the carried workspace:
\(\mu_{0,i} = \delta_{W_{i-1}}\) (with \(W_0\) empty), horizon and budget
\(H_i, B_i\) declared per stage (upstream: two-hour wall clock, no turn or
cost cap), and interaction schedule \(\kappa_i\) degenerate within the
episode: one specification delivery at \(t=0\), no further user events. The
interesting schedule is the *cross-episode* one — which requirements arrive at
which stage — and that is exactly what the synthesis strategy controls.

### 2.4 Evolution operators

Let \(\mathcal B(S)\) denote the observable-behavior relation a specification
defines at the contract (input → required output/exit/error behavior, on the
domain the spec constrains). The upstream checkpoint moves
(`docs/contributing-problems/README.md`) formalize as operators
\(o_i: S_{i-1} \mapsto S_i\):

1. **Extension** (expand constraints): \(\mathrm{dom}\,\mathcal B(S_{i-1})
   \subset \mathrm{dom}\,\mathcal B(S_i)\) and
   \(\mathcal B(S_i)\restriction_{\mathrm{dom}\,\mathcal B(S_{i-1})}
   = \mathcal B(S_{i-1})\). New inputs (rule kinds, languages, commands,
   formats) acquire required behavior; old behavior is untouched.
2. **Refinement** (narrow constraints): behavior on a previously
   *unconstrained or optional* subdomain becomes constrained (e.g. rules may
   now carry a `minutes` window field; rules without it behave as before).
   Refinement must not contradict any previously tested behavior.
3. **Input-source generalization**: the contract's input channel widens
   (`--input` accepts directories and STDIN) while the induced behavior on
   the old channel is preserved.
4. **Re-modality**: the contract surface is transformed by a declared
   morphism (CLI → REST) under which the semantic core is preserved. This is
   the strongest operator and the only one that rewrites prior obligations:
   upstream handles it by writing the new checkpoint's tests against the new
   surface, and prior tests are carried only if `include_prior_tests` remains
   true and they still apply.

**Refactoring pressure is not an operator; it is a property of the operator
sequence.** A sequence exerts design pressure when an architecture chosen
myopically at stage \(i\) makes the diff required at stage \(j>i\) large. The
paper's running example (§2, code_search): hardcoding Python at \(C_1\) causes
cascading rewrites at \(C_2\) and \(C_5\). We can make this measurable: given
two reference implementations — one architecturally naive-but-correct at
\(C_1\), one anticipatory — the pressure of a sequence is the ratio of
downstream edit cost (diff churn, or probe-agent cost) between them. A
sequence with ratio ≈ 1 tests iteration stamina, not design. This
operationalization is used as an admission predicate in
`synthesis-workflow.md` (gate G4).

> Claim limit: the churn-ratio operationalization is our proposal; the paper
> asserts design pressure per problem (Table 4) by author judgment and
> validates it only qualitatively.

### 2.5 Invariants

**Invariant (non-destructive accumulation).** For every admitted family and
every \(i<j\), the behavior required by \(T_i\) remains required at stage
\(j\):

\[
t \in \Omega_{i} \;\Rightarrow\; t \in \Omega_{j},
\quad\text{and } t \text{ remains semantically valid under } S_j .
\]

This is CE's substitute for EI's terminal restoration: EI guarantees the
*endpoint* equals the source; CE guarantees the *past is never invalidated*.
A checkpoint whose spec silently contradicts a prior sealed test destroys
attribution the same way an EI arm that swaps the verifier would — later
strict failures would measure spec incoherence, not agent degradation.
(Upstream permits an explicit, justified opt-out via
`include_prior_tests: false`; under this model that is a *declared* verifier
change and the affected transition must be labeled as such.)

**Invariant (authority separation, inherited from MODEL.md).**
\(T_i\), \(\Omega_i\), verdicts, and quality measurements never enter
\(x_{\mathrm{pub}}\) or any observation. Because episodes share no channel
except \(W\), the check reduces to: no evaluator output is ever written into
the workspace. (Upstream satisfies this; a Parallax implementation must
preserve it under any added instrumentation.)

**Invariant (workspace fidelity).** \(\mu_{0,i+1}\) is exactly the agent's
terminal \(W_i\) — no repair, no normalization beyond declared environment
reset, no reference-solution substitution. Violating this severs the causal
chain the strategy exists to study.

**Invariant (contract-only observability of the evaluator).** \(V_i\)
interacts with \(y_i\) only through the declared entrypoint. Tests that
inspect internal structure would re-impose the interface constraints the
design principles remove, and would also break language-agnosticity.

### 2.6 Strategy state machine

MODEL.md's TODO asks for states, transition guards, admission invariants, and
controlled-arm semantics. The per-family run-time state machine:

```
BUILD(i):    deliver S_i, run agent from W_{i-1} under (H_i, B_i)
  ├─ workspace produced ──────────────▶ VERIFY(i)
  ├─ budget/harness/provider fault ───▶ RUNFAILURE(i)
VERIFY(i):   execute Ω_i via entrypoint; measure quality Q(y_i)
  ├─ verifier executes (any verdict) ─▶ record Verification(i); i<n ? BUILD(i+1) : DONE
  └─ verifier infrastructure fault ───▶ RUNFAILURE(i)
RUNFAILURE(i): record run failure
  └─ policy: family continues only if W_i exists; otherwise remaining
     stages are censored (recorded, bounded worst-case in analysis —
     not silently dropped)
```

Guards worth naming because upstream leaves them implicit:

- **Continue-on-failure**: a *failing verdict* never halts the family — the
  flawed workspace carries forward by design. Only a *missing workspace*
  censors.
- **RunFailure vs Verification**: budget exhaustion with a produced workspace
  is a Verification event (the workspace is graded as-is); container,
  provider, and pytest-infrastructure faults (upstream exit codes 2–5) are
  RunFailures and must not enter effect estimates as agent failures.
  Upstream's zero-scoring of unreached checkpoints is an analysis choice; the
  Parallax treatment is worst-case identification bounds over censored
  stages, matching the Evolving Intent slice's handling of missing outcomes.

### 2.7 Estimands and controlled arms

Outcomes are indexed by stage. For a family of length \(n\), define per-stage
outcomes \(Y_i \in \{v^{\mathrm{strict}}_i, v^{\mathrm{iso}}_i,
v^{\mathrm{core}}_i\}\) and quality channels \(Q_i\) (see
`quality-measurement.md`). Two estimand shapes recur:

**Stage-matched contrasts** (MODEL.md's \(\Delta_{a,b}\), clustered by source
family and stage):

\[
\Delta_{a,b}(i)
  = \mathbb E\big[\,Y_i(a) - Y_i(b)\;\big|\;
    \text{same family, admitted, controlled}\,\big].
\]

**Slope contrasts**, new to CE — the trajectory itself is the outcome:

\[
\beta_a = \mathbb E\big[\,Q_{i+1}(a) - Q_i(a)\,\big],
\qquad
\Delta^{\beta}_{a,b} = \beta_a - \beta_b .
\]

The paper's central finding is a statement about \(\beta\): prompting
interventions move the intercept \(Q_1\) but not the slope (§3.4).

Controlled arms that respect verifier authority (all arms share
\(\Omega_i\), \(T_i\), sealed suites, budgets, agent configuration; only the
named intervention differs):

| Arm | \(\mu_{0,i}\) | \(x_{\mathrm{pub},i}\) | Isolates |
| --- | --- | --- | --- |
| `evolved` (treatment) | own \(W_{i-1}\) | \(S_i\) | the phenomenon |
| `carry-reference` | frozen reference \(y^{\mathrm{ref}}_{i-1}\) | \(S_i\) | self-accumulation: is degradation caused by building on *one's own* code? |
| `monolithic` | empty | \(S_{1..n}\) merged, single episode, matched total budget | the cost of incremental disclosure per se |
| `foresight` | own \(W_{i-1}\) | \(S_i\) plus the full roadmap \(S_{i+1..n}\) | the value of knowing future requirements while still iterating |
| `repair-scheduled` | own \(W_{i-1}\) | \(S_i\), with declared refactor-only stages inserted (\(T_{\mathrm{new}} = \varnothing\)) | reversibility of degradation |

`carry-reference` is the arm the paper explicitly declines to run (it is what
"other benchmarks" do, §1/§2.2) — which is precisely why it is the right
matched control for the self-accumulation estimand: upstream *asserts* the
causal chain matters; the matched pair tests it. The `monolithic` and
`foresight` arms are the CE analogs of EI's static arm: same terminal
requirements, different disclosure schedule; \(\delta_\kappa\) is the declared
intervention.

> Claim limit: all arms are designs, not evidence. No CE arm has been
> executed under Parallax; nothing here asserts effect directions beyond what
> the paper reports for its own single-arm setting.

### 2.8 Correspondence table

| MODEL.md concept | Checkpoint-evolution instantiation |
| --- | --- |
| Source pair \((\tau,\varepsilon)\) | seed \(\sigma\): tool/repo/benchmark family admitting decomposition |
| \(\mathcal G_\theta\) | \(\mathcal G_{\mathrm{CE}}\): plan partition + operator sequence + spec drafting + sealed-suite construction |
| \(\delta_\tau\) | per-stage goal \(g_i\) via operators \(o_i\) |
| \(\delta_\varepsilon\) | \(\mu_{0,i} = \delta_{W_{i-1}}\): agent's own artifact as initial state |
| \(\delta_\kappa\) | requirement-disclosure schedule across episodes |
| \(x_{\mathrm{seal}}\) | \(T_i \cup \Omega_{i-1}\) + normalization rules; monotone |
| Verifier authority invariant | non-destructive accumulation + contract-only observability |
| Admission \(I_j\) | gates G1–G6 in `synthesis-workflow.md` |
| Verification vs RunFailure | test verdicts vs infra faults (upstream exit 2–5), censoring policy §2.6 |
| Estimand \(\Delta_{a,b}\) | stage-matched contrasts + slope contrasts, family-clustered |

## 3. What CE measures that EI cannot

EI's outcome is recoverable in one episode: did the schedule of intent
changes prevent the agent from solving a task it could otherwise solve? The
task itself is restored; nothing the agent did persists.

CE's outcome is *compounding*: every stage's verdict is a function of every
prior stage's design decisions, because the artifact is the channel. This
gives three measurement capabilities EI structurally lacks:

1. **Self-conditioning.** The agent is evaluated on inputs it generated
   (its own workspace). Degradation attributable to consuming one's own
   output is invisible in any restore-at-the-end design.
2. **Silent-quality divergence.** Correctness and quality are measured on the
   same artifact at every stage, so quality can be tracked *conditional on
   sustained correctness* — decay that pass rates never expose.
3. **Deferred-cost realization.** A bad decision at stage \(i\) is priced by
   verdicts and costs at stages \(j>i\). This is the only design in the
   Parallax portfolio where "maintainability" has a native, sealed,
   behavioral price — the future stages themselves.
