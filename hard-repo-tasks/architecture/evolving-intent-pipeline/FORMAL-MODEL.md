# Formal model and claim boundary

Status: architecture decision, not implemented API.

This document fixes the mathematical vocabulary for the Parallax research
protocol. It separates source algorithms, Parallax design commitments,
executable checks, empirical quantities, and causal stories. The notation is
authoritative for the architecture. Current code implements only the fragments
called out under "Current evidence."

## How to read the equations

Every equation has one of five labels:

- **[D] Definition or modeling commitment.** Parallax chooses a representation
  or gives a term a precise meaning.
- **[A] Source-grounded algorithm recurrence.** A cited primary source defines
  or executes this transition.
- **[I] Mechanically checkable invariant.** Code can check the predicate for a
  concrete artifact or run under stated assumptions.
- **[E] Empirical estimand.** An experiment targets this population quantity.
  Data and an estimator may estimate it with uncertainty.
- **[H] Mechanism hypothesis.** This is a proposed explanation with observable
  predictions. It is not established by notation or benchmark performance.

Equations labeled [D], [A], [E], or [H] are not mathematical proofs.
Satisfying an [I] predicate is a mechanical proof only in the limited sense
defined below. This project does not claim machine-checked theorem proving.

## Two freeze points

Parallax uses "freeze" for two different commitments.

### Freeze the experiment before outcomes

Let

\[
\mathcal D =
(\mathcal Q,\mathcal U,\mathcal C,\mathcal Z,\mathcal M,
\mathcal A,\mathcal N,\mathcal G,\mathcal B)
\tag{D1, D}
\]

be an `ExperimentDesign` and `AnalysisPlan`. It records the question and target
population \(\mathcal Q,\mathcal U\), conditions \(\mathcal C\), assignment
schedule \(\mathcal Z\), metrics \(\mathcal M\), analysis and estimands
\(\mathcal A\), repetitions and seeds \(\mathcal N\), capability and exclusion
gates \(\mathcal G\), and stopping, missingness, and budget rules
\(\mathcal B\).

The design is frozen when its canonical content and identity are committed
before any treatment outcome \(Y_i(z_i)\) is visible to the designer or
analysis selector:

\[
t_{\mathrm{freeze}}(\mathcal D)
<
\min_i t_{\mathrm{visible}}(Y_i(z_i)).
\tag{D2, I}
\]

Calibration outcomes may inform a later design only if the calibration units
and decisions are recorded and the measurement sample remains untouched.
Freezing does not mean that every paper or benchmark pins every field above.
It is a Parallax requirement for experiments admitted to make controlled
claims.

### Freeze accepted construction before compilation

Stochastic construction may call providers and judges. Once Parallax accepts a
construction record \(G\), it commits every semantic input, accepted response,
parse, validator, model parameter, seed, source revision, and external-asset
digest. Deterministic compilation then consumes only that record:

\[
G \sim \mathrm{Construct}(\cdot \mid X,\lambda),\qquad
B = \mathrm{Compile}(\mathrm{Freeze}(G)).
\tag{D3, D}
\]

No provider call, sampling, clock value, mutable counter, or network fetch may
occur in `Compile`. Rejected construction attempts remain evidence but do not
become compiler inputs.

The Evolving Intent paper fixes source evaluation IDs, the terminal source
anchor, and the reported main condition of one source turn versus seven turns
with two revisions and two switches. At Microsoft commit
`993d6be9597ac03854b46362ccd647eb1bfd267a`, evaluation-mode prefix selection
cycles deterministically and training mode samples from a seeded generator.
The commit also fixes scheduler, prompt, and renderer code.

It does not freeze the generated extraction, counterfactual, predecessor, or
result files. Those files are gitignored and must be regenerated. Runner
parameters remain configurable, dependencies are lower bounds and
`mini-swe-agent` is unversioned, external BrowseComp+ assets are acquired
separately, and provider model names do not identify immutable weights. The
repository has no immutable run-assignment ledger or complete paper-output
bundle. Evolving Intent does not claim byte-identical dataset or result replay.

SlopCodeBench paper v2 fixes 36 authored problems and 196 ordered checkpoints,
the printed prompt templates, reported native harness versions and reasoning
levels, a two-hour checkpoint limit, fresh non-root containers, and
workspace-only persistence. It reports the best `just-solve` run per model,
selected by isolated solve rate with stated tie-breakers. Its Zenodo record
links runner tag `v0.2`, which GitHub resolves to exactly
`bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1`.

That release does not form a Parallax-style lock. Its Python dependencies use
lower bounds, its environment names a mutable Docker tag rather than an image
digest, and the Zenodo artifact contains the paper rather than complete run
inputs and outputs. The paper does not report a randomized assignment ledger
or repeated-seed uncertainty for each model configuration. Current runner
commit `8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b` later pinned
`scb-check==0.1.3` after showing that an unpinned metric dependency changed
verbosity by 2.42 times on fixed input. That repair is evidence of metric drift,
not evidence that paper-era runs used version 0.1.3. SlopCodeBench does not
claim byte-identical replay.

## Research protocol as an MDP or POMDP

Parallax models an admitted environment under condition \(z\) as

\[
\mathcal E_z =
(\mathcal S,\mathcal O,\mathcal A,P_z,\Omega_z,R_z,\rho_{0,z},
H_{\max},\gamma).
\tag{D4, D}
\]

`EnvironmentSpec` commits the latent state space \(\mathcal S\), observation
space \(\mathcal O\), action and tool space \(\mathcal A\), transition kernel
\(P_z(s_{t+1}\mid s_t,a_t)\), observation kernel
\(\Omega_z(o_t\mid s_t)\), reward authority \(R_z\), reset distribution
\(\rho_{0,z}\), horizon or termination policy \(H_{\max}\), and discount
\(\gamma\). Episodic benchmark evaluation normally uses \(\gamma=1\), but the
field must be explicit for training or discounted objectives. Runtime images,
assets, network and filesystem policy, budgets, and data-split membership are
identity-bearing parameters of these terms.

An agent is generally history-dependent:

\[
\pi_{\theta,z}(a_t\mid h_t),\qquad
h_t=(o_0,a_0,o_1,a_1,\ldots,o_t).
\tag{D5, D}
\]

`PolicySpec` commits \(\theta\) or its model identifier, harness, prompts,
reasoning and decoding settings, memory policy, tool policy, and exposed
intervention. Tool outputs, assistant messages, and tool-call traces belong in
\(h_t\). A raw tool history need not be Markov. If it affects future dynamics,
the environment state must include the relevant workspace, service, budget,
cache, and scheduler state so that \(P\) is Markov on the augmented
\(\mathcal S\). The policy may still depend on the complete observed history.

In a POMDP, the agent does not observe \(s_t\) directly. It receives
\(o_t\sim\Omega_z(\cdot\mid s_t)\) and may maintain a belief
\(b_t(s)=\Pr(s_t=s\mid h_t)\). Evolving Intent's active intent is latent and
rendered through utterances. Checkpoint evolution exposes a materialized
workspace but may hide tests, evaluator state, and future specifications.

The protocol records map as follows:

- `EnvironmentSpec` commits \(\mathcal E_z\).
- `PolicySpec` commits \(\pi_{\theta,z}\).
- `Intervention` identifies one controlled change to environment, policy,
  memory, tools, reward, data, or update rule.
- `Condition` binds that intervention to all held-constant commitments.
- `RunReport` is trajectory evidence
  \(\tau=(s_0,o_0,a_0,\ldots,s_T,o_T,a_T,r_T)\), with latent states omitted
  where they are unavailable and with failures retained.
- `ExperimentDesign` defines assignment and target estimands.
- `AnalysisPlan` defines estimators, uncertainty, missingness handling, and the
  assumptions needed to interpret them causally.

Condition \(z\) may change \(P_z,\Omega_z,R_z,\rho_{0,z}\), or the policy
\(\pi_{\theta,z}\). Prompt, harness, memory, and tool-selection changes are
policy-system interventions even when model weights stay fixed. A training
intervention additionally defines an update operator
\[
\theta_{z,s}=U_z(\theta_0,D_{\mathrm{train}},s)
\tag{D5a, D}
\]
and compares resulting policies on the same held-out evaluation. A benchmark
contrast between fixed policies does not identify the effect of \(U_z\).

Randomization supports exchangeability only for the assigned contrast.
Consistency, positivity, interference boundaries, capability, valid
measurement, and declared missingness handling still require checks. A
`RunReport` supplies evidence. It does not supply causal identification by
itself.

## Evolving Intent model

### Source extraction and retrospective construction

For a source benchmark record \((q,y^*)\), the paper defines stochastic
extraction:

\[
(f^*,C^*) \sim \mathrm{Extract}(\cdot\mid q).
\tag{A1, A}
\]

Parallax represents \(C_t\) as a typed finite map from argument slots to active
values. The revealed set \(C_t^{\mathrm{rev}}\) is a set of slots, not a second
map. This removes ambiguity when a revision changes a value but not the slot.
The intent state is

\[
I_t=(f_t,C_t,C_t^{\mathrm{rev}},y_t),\qquad
C_t^{\mathrm{rev}}\subseteq\operatorname{dom}(C_t).
\tag{A2, A/D}
\]

The paper's state tuple grounds the form. Typed slots and maps are the Parallax
commitment.

For each source slot \(i\), construction may create an accepted revision chain

\[
c_i^{(0)}\rightarrow c_i^{(1)}\rightarrow\cdots\rightarrow c_i^{(m_i)}=c_i^*,
\quad
c_i^{(j)}\sim
\mathrm{Counterfact}(\cdot\mid c_i^{(j+1)},f^*).
\tag{A3, A/D}
\]

The paper directly defines counterfactual generation conditioned on a source
argument and function. Chains and their accepted order are explicit Parallax
records. A chain may advance only to its committed successor.

Let \(F_k=(f_k,C_k)\) and \(F_K=(f^*,C^*)\). A predecessor chain uses the
source recurrence:

\[
F_{k-1}\sim\mathrm{Predecessor}(\cdot\mid F_k),
\qquad
\operatorname{dom}(C_{k-1})\cap\operatorname{dom}(C_k)\ne\varnothing.
\tag{A4, A}
\]

Recursive conditioning is on the immediate successor, not always on the
terminal source.

### Typed transitions and scheduling

Parallax admits only three typed transition operations:

\[
\begin{aligned}
\mathrm{Reveal}(i)&:
 i\in\operatorname{dom}(C_t)\setminus C_t^{\mathrm{rev}},
 &C_{t+1}^{\mathrm{rev}}&=C_t^{\mathrm{rev}}\cup\{i\};\\
\mathrm{Revise}(i,v,v')&:
 i\in C_t^{\mathrm{rev}}\land C_t(i)=v,
 &C_{t+1}(i)&=v';\\
\mathrm{Switch}(F_k,F_{k+1})&:
 F_k\text{ is active and fully revealed},
 &F_{t+1}&=F_{k+1}.
\end{aligned}
\tag{A5, D/I}
\]

`Revise` requires \(v'\) to be the next value in the frozen chain.
`Switch` requires \(F_{k+1}\) to be the next frozen successor and carries only
arguments declared shared by the two frames. Other state is unchanged unless
the event type says otherwise.

For \(g\) switches, \(p\) revisions, and \(T\) turns, the source scheduler
requires

\[
T\ge 1+g+p.
\tag{A6, A/I}
\]

It initializes the first slot with one active function and at least one reveal,
reserves switch and revision slots, reveals each counterfactual strictly before
its correction deadline, fills remaining slots with valid reveals, and orders
same-turn events as function event, revision, then reveal. Parallax replays the
complete slot list before rendering. Each event must satisfy [A5], each
revision must follow a reveal, each predecessor must precede its successor,
and a switch may occur only from a fully revealed active frame.

The paper writes the rendered update schematically as
\(\Delta I_t:=I_t\setminus I_{t-1}\). Set subtraction does not fully describe
revisions. Parallax defines a typed delta as the event and changed fields:

\[
\delta_t=\mathrm{Diff}_{\mathrm{typed}}(I_{t-1},I_t),\qquad
u_t\sim U(\cdot\mid\delta_t,h_{t-1}).
\tag{A7, D}
\]

The default renderer emits only \(\delta_t\), not the complete active intent.
Any stochastic prefix choice or LLM naturalization belongs to accepted
construction evidence before compilation.

Every admitted trajectory restores the source:

\[
I_T=(f^*,C^*,\operatorname{dom}(C^*),y^*).
\tag{A8, A/I}
\]

The native source verifier evaluates the final action against \(y^*\). This
does not natively verify every intermediate intent or utterance.

For valid units in a declared population, the primary treatment-control target
is

\[
\tau_{\mathrm{EI}}=
\mathbb E\!\left[
Y_i(\text{evolved})-Y_i(\text{turn-matched no-change})
\right].
\tag{E1, E}
\]

The turn-matched control holds call count and declared budgets fixed. A static
arm answers a separate single-turn transfer question and is not a substitute
for the turn-matched contrast. A paired estimator, blocking, repetitions,
uncertainty, and invalid-run policy must be fixed in \(\mathcal D\).

The claim that failures arise from poor active-intent belief updates is

\[
\text{intent-state update failure}
\longrightarrow
\Pr(Y=1\mid\text{evolved})\downarrow .
\tag{H1, H}
\]

It is a mechanism hypothesis. Evolved-versus-matched reward alone does not
isolate it from context interference, tool-budget use, renderer artifacts, or
harness behavior.

## Checkpoint evolution model

A checkpoint problem is a fixed ordered sequence

\[
P=[K_1,\ldots,K_n],\qquad
K_i=(x_i,v_i^{\mathrm{current}},b_i,e_i),
\tag{A9, D}
\]

where \(x_i\) is the black-box specification, \(v_i^{\mathrm{current}}\) the
checkpoint's native tests, \(b_i\) its budget, and \(e_i\) its committed
environment. Prior tests form cumulative obligations:

\[
V_i=v_i^{\mathrm{current}}\cup\bigcup_{j<i}v_j^{\mathrm{current}}.
\tag{A10, A/I}
\]

With empty initial workspace \(W_0\), the source recurrence is

\[
W_i=\pi_\theta(x_i,W_{i-1}).
\tag{A11, A}
\]

The notation hides an important reset boundary. Parallax expands it to

\[
W_i=
\mathrm{Snapshot}\!\left(
\pi_\theta(
x_i,\mathrm{Materialize}(W_{i-1});
\ h_i^{\mathrm{agent}}=\varnothing,
\ e_i^{\mathrm{ephemeral}}=\mathrm{Clean}(e_i)
)\right).
\tag{D6, D/I}
\]

Only the committed workspace snapshot persists. Conversation, agent session,
shell history, installed packages, process state, and undeclared caches reset.
The before-snapshot for checkpoint \(i\) must equal the after-snapshot from
\(i-1\).

The per-checkpoint native verdict is

\[
Q_i=\mathbf 1[\forall v\in V_i,\ v(W_i)=\mathrm{pass}].
\tag{A12, A/I}
\]

Strict correctness uses \(Q_i\). Isolation and core verdicts use their declared
test subsets. Structural erosion and verbosity follow the source definitions:

\[
\mathrm{mass}(f)=\mathrm{CC}(f)\sqrt{\mathrm{SLOC}(f)},\qquad
\mathrm{Erosion}(W)=
\frac{\sum_{\mathrm{CC}(f)>10}\mathrm{mass}(f)}
     {\sum_f\mathrm{mass}(f)},
\tag{A13, A}
\]

\[
\mathrm{Verbosity}(W)=
\frac{\left|
\mathrm{ASTGrepFlaggedLines}(W)\cup\mathrm{CloneLines}(W)
\right|}{\mathrm{LOC}(W)}.
\tag{A14, A}
\]

These are diagnostic metrics. They are not reward unless a Parallax design
pre-registers a composite outcome and its tradeoff.

For prompt \(p\), a valid prompt contrast targets

\[
\tau_p=\mathbb E[Y_i(p)-Y_i(p_0)]
\tag{E2, E}
\]

with the same problems, model weights, harness version, environment, budgets,
assignment policy, and repetition policy. `just-solve`, `anti-slop`, and
`plan-first` are prompt interventions, not training interventions. A slope
contrast in erosion or verbosity and a correctness contrast are different
estimands and must be declared separately.

The hypothesis that early architecture causes later erosion is a mediated,
longitudinal mechanism claim [H]. The recurrence [A11] makes that mechanism
possible, but does not identify it. Prompt trajectories or observational
human-repository comparisons do not by themselves isolate the causal path.

## Pinned upstream and production ownership

Parallax reimplements accepted algorithms from first principles in production.
The pinned Microsoft Evolving Intent implementation and a pinned
SlopCodeBench release are characterization references and test oracles only.
Tests may invoke them in a dedicated environment through a subprocess or a
narrow import adapter. Production modules must not import, vendor, call, or
silently fall back to either runtime.

Characterization fixtures compare typed state transitions, schedule structure,
deterministic-prefix rendering, reset behavior, and native verdicts at a named
upstream revision. This catches semantic drift when Parallax changes a
transition precondition, ordering rule, carried field, or renderer contract
while still producing superficially plausible tasks.

Intentional divergences belong in the ADR and characterization receipt with:

- the upstream revision and observed behavior;
- the Parallax behavior and reason;
- the affected fixtures and checks;
- whether the divergence changes an estimand, condition, or artifact identity.

Mutable upstream prefix counters are one known behavior Parallax will not copy.
Imported upstream JSON remains source-digested characterization evidence and
cannot seal or enter a production family.

## Byte-identical locked replay

Let \(F\) be canonical frozen input, \(C\) a deterministic compiler, and
\(\operatorname{Enc}\) canonical serialization:

\[
B=\operatorname{Enc}(C(F)),\qquad
\operatorname{ID}=H(B_{\mathrm{public}},B_{\mathrm{sealed}}).
\tag{D7, D}
\]

A locked replay succeeds exactly when it verifies every locked input digest,
rebuilds from those inputs without stochastic or external acquisition, and
produces the same relative file set, bytes, file digests, task IDs, and family
ID:

\[
F'=F
\Longrightarrow
B'=B\ \land\ \operatorname{ID}'=\operatorname{ID}.
\tag{I1, I}
\]

This is artifact replay. It is not replay of an agent rollout. It matters
because any semantic compiler drift, input tampering, or non-canonical output
changes identity or fails the lock. It proves neither that stochastic
construction was correct, nor upstream parity, task validity, causal effects,
agent determinism, native evaluator soundness, or paper-result reproduction.

The closest established analogy is a reproducible build: the same declared
source, environment, and instructions recreate bit-for-bit identical specified
artifacts, usually checked by cryptographic digest. Content-addressed stores
provide the identity half of the same contract. Parallax narrows that idea to
canonical research artifacts built from a family lock. Neither Evolving Intent
nor SlopCodeBench claims this property for its generated datasets, run outputs,
or agent trajectories.

Unit 0 demonstrates [I1] for one hand-authored GSM8K proposal: two seven-file
trees and family
`5ebc593aee75327d17e2a9d01c2e8f86752566990c7eafeaee5c2dcb55469cf7`
were byte-identical. The newer proof binds the exact dirty-worktree inputs by
relative path and SHA-256 while retaining base HEAD, relevant git status, and
the tracked-diff digest. The proposal still contains placeholder
prompt/response digest strings and a `school_supply_sales` versus Natalia's
clips mismatch. The proof therefore establishes artifact determinism for exact
bytes, not proposal provenance integrity, semantic validity, Microsoft
generation, upstream scheduler or renderer parity, provider behavior, external
assets, HUD rollout, or checkpoint execution.

## Mechanical proof, estimation, and identification

In this architecture, a mechanical proof is an executable predicate over
committed bytes and typed records under explicit assumptions. Examples are:

- typed event replay reaches [A8] and rejects an invalid transition;
- lock and content hashes establish [I1] for the supplied files and hash
  implementation;
- a native oracle passes and a known-wrong answer fails;
- asset, source, verifier, or hidden-test tampering changes identity or blocks
  admission;
- checkpoint replay enforces snapshot continuity, fresh context, and all
  cumulative regression obligations.

The assumptions include trusted canonicalization and hash implementations,
complete identity fields, the declared verifier, and the absence of unmodeled
external state. Mechanical proof establishes only the checked invariant for
the tested inputs.

Empirical estimation uses repeated outcomes to estimate [E1], [E2], or another
pre-registered estimand with uncertainty. Causal identification additionally
requires a design and assumptions that connect the observed estimator to
potential outcomes. Passing every mechanical check does not identify an
effect. A randomized controlled design does not prove artifact invariants.

## Verification skill architecture

Keep one app-level `.cursor/skills/verify-parallax/` skill as the user entry
point. Each admitted user path may add an independently executable helper and
an immutable receipt once that path exists and can be driven end to end.
Helpers may have their own prerequisites and isolation, but the top-level skill
owns Launch, Doctor, Drive, Evidence, and Cleanup conventions.

Create a separate skill only when a secondary interface has genuinely different
launch or isolation semantics, such as a long-running service with its own
process lifecycle or a separately installed runtime that cannot share the
Parallax doctor and cleanup contract. Do not add proposed Evolving Intent,
external-asset, SWE-bench Verified, or checkpoint-evolution entries to the
current feature map before real Parallax user paths exist.

## Performance interventions and required contrasts

Every performance claim must name the intervention layer and hold the other
layers fixed, or define the compound intervention explicitly.

- **Policy weights.** Compare committed checkpoints under the same harness,
  prompt, memory, tools, environment, task sample, and budgets. This estimates
  a checkpoint or policy contrast, not the effect of the training method that
  produced it.
- **Prompt or agent scaffold.** Compare prompt or harness variants with the
  same weights, environment, tools, memory reset, tasks, and budgets.
- **Memory or state.** Compare declared memory exposure or persistence with
  weights, prompts, tools, environment, and budgets fixed. Audit leakage and
  reset fidelity.
- **Tools.** Compare tool availability or policy with weights, prompts,
  environment, task sample, and matched budget accounting fixed.
- **Environment or curriculum.** Compare environment dynamics, task sequence,
  or data distribution with policy and evaluation fixed. Training claims also
  require uncontaminated held-out evaluation.
- **Reward.** During training, compare reward definitions with the update
  algorithm, initialization, data, compute, and evaluation fixed. Evaluation
  reward changes alone compare graders, not learned behavior.
- **Training update.** Compare update algorithms or data interventions from a
  common initialization with reward, compute, sampling, and held-out
  evaluation fixed, replicated across declared seeds.

If more than one layer changes, the estimand is the effect of the bundle. It
cannot be attributed to one component.

## Full research loop

For iteration \(k\), Parallax records

\[
\begin{aligned}
O_k
&\xrightarrow{\text{operational predicate}} F_k
\xrightarrow{\text{propose}} H_k
\xrightarrow{\text{target}} J_k
\xrightarrow{\text{bind constants}} C_k\\
&\xrightarrow{\text{admit and run}} R_k
\xrightarrow{\text{measure}} Y_k
\xrightarrow{\mathcal A_k} \widehat{\tau}_k
\xrightarrow{\text{bound}} B_k
\xrightarrow{\text{human review}} Q_{k+1}.
\end{aligned}
\tag{D8, D}
\]

\(O_k\) is observed evidence, \(F_k\) a behavioral-failure classification,
\(H_k\) a mechanism hypothesis, \(J_k\) an intervention, \(C_k\) a condition,
\(R_k\) verified run evidence, \(Y_k\) an outcome, \(\widehat{\tau}_k\) an
estimate, \(B_k\) a finding bounded by assumptions and uncertainty, and
\(Q_{k+1}\) a candidate next question. No arrow automatically promotes its
input to the next claim type. Failed gates or invalid measurement yield an
inconclusive record and a revised question, not a policy failure.

## No-go claim rules

- Invalid submission, parse failure, provider failure, harness fault, or failed
  capability gate is not policy failure.
- A benchmark delta is not evidence of a training mechanism.
- One before-and-after run is not a training effect.
- Erosion, verbosity, intent-prediction score, cost, and tool use are
  diagnostics unless the frozen design names them as outcomes or reward.
- A static-versus-evolved delta does not isolate added turns. Use the
  turn-matched control for that claim.
- A final native verdict does not validate intermediate generated intent.
- Byte-identical replay does not establish semantic correctness or agent
  rollout reproducibility.
- A source-grounded recurrence does not prove that current Parallax code
  implements it.

## Current evidence and remaining blockers

Current Parallax code has content-addressed records, deterministic family
compilation, typed but incomplete intent events, terminal-anchor replay,
GSM8K oracle and known-wrong checks, tree snapshots, and typed grading
outcomes. `CheckpointPlan`, `WorkspaceEpisode`, and `CheckpointSequence` do not
execute checkpoint evolution. The current accepted `ProposalBundle` path
consumes a hand-authored fixture and does not execute [A1], [A3], [A4], or the
source scheduler. Its digest-shaped provenance fields are caller-supplied
placeholders, so family identity cannot establish their integrity.
`EnvironmentSpec`, `PolicySpec`, `ExperimentDesign`,
`AnalysisPlan`, and `RunReport` are target records, not current APIs. The
bespoke SWE-bench schedules are not Evolving Intent parity.

The literature review resolves the paper and release boundaries, but not the
missing artifacts:

- Microsoft publishes source IDs and code, not the paper's exact generated
  conversations, all provider and judge calls, provider snapshots, or complete
  result rows.
- SlopCodeBench Zenodo record `19257129` identifies runner tag `v0.2`, and that
  tag resolves to `bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1`. The record does
  not identify a separate paper-era problem-catalog commit, immutable
  container-image digest, or complete run bundle.
- Parallax still needs executable characterization of SloP hidden-test
  integrity, cumulative regression inclusion, checkpoint reset, and snapshot
  continuity. Paper statements are not receipts for Parallax's environment.
- Asset retention and redistribution terms remain unresolved for BIRD-SQL,
  BrowseComp+, SWE-bench, and SloP hidden evaluation assets.
- Contemporary intervention papers report author-run benchmark gains. Their
  transfer to Parallax, combined use, and independent replication remain open.

## Primary sources

- [LLMs Get Lost in Evolving User Intent](https://arxiv.org/abs/2607.20734)
  and pinned
  [Microsoft implementation](https://github.com/microsoft/evolving-intent/tree/993d6be9597ac03854b46362ccd647eb1bfd267a)
- [SlopCodeBench v2](https://arxiv.org/html/2603.24755v2), runner
  [`v0.2`](https://github.com/SprocketLab/slop-code-bench/tree/bed5ae2ae2ec8f5c474d7b5e1ac1448c84a2cba1),
  and its pinned
  [problem-design guide](https://github.com/SprocketLab/slop-code-bench/blob/8e3a8b693f3c5e48143aeb7cb5b1beda1f19c44b/docs/contributing-problems/README.md)
- [`LITERATURE-REVIEW.md`](LITERATURE-REVIEW.md) records the inspected source
  revisions, causal limits, and intervention evidence.
- Unit 0
  [locked-replay receipt](../../.cursor/skills/verify-parallax/evidence/unit0-family-build-rerun/receipt.json)
