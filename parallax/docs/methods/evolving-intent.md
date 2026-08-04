# Evolving Intent method

Evolving Intent is one synthesis strategy
$\mathcal G_{\mathrm{EI}}$ in the [Parallax research
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

Let $(\tau^\star,\varepsilon^\star)$ be a verifiable source pair, with source
answer $y^\star$ held by verifier authority $V^\star$.

**Definition (extraction).** Extract source intent as a function and arguments:

```math
E(\tau^\star_{\mathrm{pub}})
  = I^\star
  = (f^\star,\alpha^\star),
\qquad
\alpha^\star=(a_1^\star,\ldots,a_m^\star).
```

**Definition (argument counterfactuals).** For each eligible argument $j$,
construct accepted alternatives
$C_j=\{a_{j,1}',\ldots,a_{j,n_j}'\}$. Each alternative changes that argument
without changing the evaluator's authority over the source task.

**Definition (predecessor chain).** Construct functions from an earlier intent
toward the source:

```math
f_{-k}\rightarrow f_{-(k-1)}\rightarrow\cdots\rightarrow f_{-1}
\rightarrow f^\star.
```

Each predecessor is conditioned on its immediate successor and the arguments
needed to make that transition coherent. Construction may escalate to a
fallback model after a declared number of failed attempts. Fallback escalation
is a construction policy, not an agent-visible event.

**Definition (intent trajectory).** At user turn $t$, let

```math
z_t=(f_t,v_t,r_t)
```

contain the active function, active argument values, and revealed argument
identifiers. The trajectory
$\zeta=(z_0,\ldots,z_T)$ advances through predecessor functions,
counterfactual values, corrections, and reveals.

**Invariant (terminal restoration).**

```math
z_T=(f^\star,\alpha^\star,\{1,\ldots,m\}),
\qquad
V_{\mathrm{EI}}\equiv V^\star,
\qquad
y_{\mathrm{target}}=y^\star.
```

The conversation may evolve, but final evaluation retains the source verifier,
sealed authority, and answer.

**Definition (schedule and rendering).** Function changes, corrections, and
reveals form an event set $\mathcal E$ with dependency relation $\prec$.
A schedule is a turn assignment that is a linear extension of
$(\mathcal E,\prec)$: predecessor phases move toward $f^\star$, events occur
under their owning function phase, and source restoration is terminal. The
renderer maps scheduled state deltas to user messages. When several deltas
share a turn, the consulted implementation renders function change, correction,
then reveals.

Benchmark overlays may refine ownership or argument ordering without changing
terminal restoration or verifier authority.

## Controlled comparison

**Invariant (matched authority and budget).** Static, matched, and evolving
arms use the same source-task distribution, $V^\star$, sealed evaluator
information, agent configuration, and declared resource budget. A matched
control should equalize interaction length or exposed information according to
the experiment design. Any remaining arm difference must be named as an
intervention.

**Hypothesis.** An evolving trajectory can expose failures that a static or
matched presentation of the same verifiable task does not. The effect is an
empirical estimand under the controlled-arm rules in `MODEL.md`, not a property
assumed by construction.

## Required behavioral coverage

The independent implementation requires Parallax-owned regression coverage for:

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

> [!NOTE]
> The executable GSM8K slice covers extraction, argument counterfactuals,
> predecessor fallback, typed trajectory construction, seeded dependency
> scheduling, rendering, terminal restoration, matched budgets, native grading,
> deterministic run evidence, and paired reporting.

## GSM8K slice choices

The slice makes the following choices where the paper and reference leave room
for an implementation:

- Construction uses one synchronous `Chat` callable. Every stage returns one
  strict JSON object parsed into a frozen model with unknown fields forbidden.
  The primary predecessor generator gets two attempts, then an optional
  fallback generator gets one attempt.
- The slice generates one accepted counterfactual for every extracted
  argument. It retains every accepted and rejected output with the model label
  and acceptance reason.
- The first vertical slice uses one immediate predecessor function. Each reveal,
  revision, and switch occupies one turn. A seeded randomized topological sort
  orders ready events. The switch back to the source function depends on every
  reveal, while a correction may follow that switch. Terminal restoration is
  exact final-state equality, not a rule about the last event type. Events carry
  explicit `reveal`, `revise`, or `switch` discriminator values in evidence.
- The matched intervention is a turn-count-and-budget-matched progressive
  source reveal. It keeps the source function and source argument values for
  the whole conversation. Extra turns restate continuity without adding a
  revision or function switch.
- Static uses the same extracted intent as the other arms and renders its
  function and all source arguments in one turn. The raw source question is
  never rendered. Static's total declared output-token budget equals the
  matched and evolved totals. Matched and evolved also have identical per-turn
  budgets.
- GSM8K grading accepts canonical integers only. The final model marker is
  `FINAL_ANSWER: <integer>` on the final non-empty line. Source authority uses
  the final `#### <integer>` line. Source authority is validated and branded
  when `Problem` is created; grading trusts that proof and validates only the
  model submission.
- Parallax preregisters expected source-trial units before execution. The paired
  report averages trial bounds within each source, then averages across source
  clusters. Recorded run failures produce worst-case identification bounds.
  A closed-form Hoeffding term supplies the deterministic 95% interval.

These choices preserve semantic fidelity without claiming provider-text parity
with the consulted implementation.

## SWE-bench Verified slice choices

The SWE adapter pins the paper's 50 published evaluation IDs, the Verified
dataset revision, the official harness revision, and each official eval image
digest. Ingestion discards the gold patch. The public issue statement, repo,
base commit, and version remain separate from the sealed test patch,
FAIL_TO_PASS list, PASS_TO_PASS list, test command, and verifier commitments.

Construction returns categorized arguments. The adapter removes
`category="symptom"` arguments from each phase's scheduled argument order, then
reinserts those symptoms at the front of the owning phase before rendering.
This is the narrow behavior characterized in the pinned upstream SWE overlay.
The evidence records both the stripped symptom IDs and the final injected
order.

The first SWE implementation schedules whole function phases rather than
reproducing upstream provider prompts or every generic scheduler slot. Each
predecessor phase is followed by an exact source-intent phase. The terminal
turn also carries the source issue statement. This is a declared Parallax
restriction for the screening slice, not a claim of provider-text or dataset
parity.

SWE arm semantics differ from the GSM8K presentation where the benchmark
requires them:

- Static receives the full public source issue once.
- Matched receives the same number of turns as evolved without a function,
  requirement, or verifier change.
- Evolved traverses the constructed predecessor phases and restores the exact
  source intent on its final turn.
- Every arm receives the same total agent-step and output-token budget. Static
  receives that budget in one turn; matched and evolved divide it across
  turns.

`TaskSpecV1` separates `PublicTaskV1` from `SealedAuthorityV1`.
`compile_hud` creates agent artifacts only from the public branch. It tags each
artifact as agent or evaluator, scans the agent build context for sealed
fragments, and records a digest receipt. The HUD runtime uses a probed
`bubblewrap` Workspace and exports a binary Git patch. The evaluator reloads
its compiled artifact and calls `swebench.harness.run_evaluation` at the pinned
harness revision in the digest-pinned official image. The official `resolved`
verdict is authoritative. Parallax checks that the report covers every
committed FAIL_TO_PASS and PASS_TO_PASS test without serializing those names
into run rows.

Screening summaries expose the source-clustered interval and
minimum-detectable-effect so that a reader can see how little a small design
resolves, even when its observed pass rate is extreme.

## Interpretation and limits

Where the paper leaves behavior open, a Parallax adapter must document its
interpretation.

> [!IMPORTANT]
> Every intentional difference from the consulted implementation requires an
> explicit rationale and behavioral regression coverage.

Upstream seed reproducibility is limited across benchmarks. GSM8K extraction
and counterfactual pools use worker-completion order, and its predecessor
generator creates an unseeded `random.Random()` instance. BIRD-SQL also uses
global shuffling and completion-order collection. Parallax's deterministic
local scheduler is a deliberate scientific choice, not upstream parity.

The consulted SWE overlay strips symptom arguments before scheduling and
reinserts them later. Its final category sort can place symptoms after
recognized categories.

The upstream generated pools and provider transcripts are not published in the
repository. Parallax therefore makes no claim of byte-identical dataset
reproduction, provider replay, or paper-score reproduction.

> [!WARNING]
> Generated pools and provider transcripts are unavailable. Reported results
> cannot be treated as reproductions of the paper without independently
> retained construction and evaluation evidence.
