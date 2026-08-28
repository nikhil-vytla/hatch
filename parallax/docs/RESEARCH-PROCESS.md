# The Parallax research process

This document walks a new collaborator through the full Parallax research
process: what problem the harness solves, how one experiment moves from an
observed agent failure to a bounded finding, how to rerun the evidence, and
where the honest limits are. It assumes no prior context. The vocabulary it
uses is defined in [`MODEL.md`](MODEL.md); the strategy it walks through is
specified in [`methods/evolving-intent.md`](methods/evolving-intent.md). If
you want the concrete version first — real inputs, exact commands, real
output artifacts for every implemented flow — start with
[`PIPELINES.md`](PIPELINES.md) and come back here for the reasoning.

## The problem Parallax solves

Modern agents fail in ways that are easy to notice and hard to study. A model
that solves a task when it is stated up front may fail when the user's intent
arrives piecemeal, changes mid-conversation, or is corrected late. Anecdotes
about such failures do not support training or environment decisions, because
an uncontrolled comparison confounds the interesting cause (how the task was
presented) with boring ones (different tasks, different budgets, different
graders, silently dropped failures).

Parallax turns an observed failure mode into a controlled, auditable
experiment. Its core commitments:

- **Sealed grading authority.** The correct answer and the verifier are held
  by the evaluator only. No experiment arm may leak them to the agent or
  change them, so a measured difference cannot be an artifact of grading
  drift.
- **Matched arms.** Every comparison isolates one named intervention. All
  other factors, including source tasks, budgets, turn counts, and the
  grader, are equalized or declared.
- **Evidence before interpretation.** Every scheduled run produces a retained
  record. Reports are recomputed from that evidence, and refuse to aggregate
  evidence that has drifted from the preregistered design.
- **Bounded claims.** Findings state what the design can identify and no
  more. Failed runs widen the reported bounds instead of vanishing from
  denominators.

## The research loop

Each Parallax study follows one loop:

1. **Observed failure mode.** A concrete, repeatable misbehavior in a real
   agent, for example losing track of the user's goal as it evolves.
2. **Research question.** A falsifiable statement with a declared effect
   direction and a magnitude worth caring about, for example: presenting the
   same verifiable task through an evolving intent trajectory lowers the pass
   rate relative to a matched multi-turn control.
3. **Controlled intervention.** The single difference between arms is named
   as the intervention. Everything else is matched.
4. **Task and environment construction.** A synthesis strategy transforms
   existing verifiable tasks into experiment arms, and admission checks
   reject constructions that leak sealed answers or break the contract.
   Evolving Intent over GSM8K is the implemented strategy.
5. **Verified runs.** Every scheduled (source, trial, arm) unit executes and
   is graded by the sealed native verifier. Infrastructure faults are
   recorded as run failures, distinct from wrong answers.
6. **Paired contrast with identification bounds.** The report estimates the
   paired arm difference clustered by source task, treats missing outcomes
   with worst-case and best-case bounds, and wraps the result in a
   closed-form 95% confidence interval.
7. **Bounded finding.** The report states the point estimate, the interval,
   and the smallest effect that interval could have resolved. The finding is
   those numbers, not a narrative and not a verdict.
8. **Next hypothesis.** The finding, including an uninformative one, narrows
   the next question. The loop repeats.

## A walked example: Evolving Intent over GSM8K

GSM8K is a pool of grade-school math word problems whose canonical answers
have the form `#### <integer>`. Each problem becomes one source task. The
integer answer is stripped from everything the agent sees and retained as
sealed grading authority.

### Construction

A construction model (any synchronous chat callable returning strict JSON) is
asked to extract the source intent as a function with arguments, propose
accepted counterfactual values for eligible arguments, and build predecessor
intents that step toward the source intent. Rejected construction attempts
are retained in the evidence alongside accepted ones, once per source.
Scheduling of intent events onto turns is seed-deterministic. This is a
declared divergence from the consulted upstream implementation, whose
construction order is not reproducible from a seed.

### Three arms

Every source task yields three scripts that share the extracted intent, the
sealed answer, the verifier, and the declared output budget:

- **Static.** One turn that renders the fully revealed extracted intent. No
  arm renders the raw source question, so rendering style cannot confound
  the comparison. This arm measures baseline capability with no multi-turn
  dynamics.
- **Matched.** A progressive reveal of the source intent, matched to the
  evolved arm in turn count and per-turn output budget. The intent never
  changes; information only accumulates. This is the control: it carries
  every cost of multi-turn interaction except intent evolution. The source
  paper used the same kind of turn-matched control to show that added turns
  alone did not explain its measured drop; Parallax makes that control a
  structural requirement rather than one ablation.
- **Evolved.** The intervention. The conversation opens under a predecessor
  intent, then moves through corrections and reveals, and terminally
  restores the exact source function, arguments, and reveals. The final
  state the agent must answer is checked for exact equality with the source
  intent, so the sealed answer remains the right grading authority.

The primary contrast is matched versus evolved. Because those two arms agree
on turn count and budget, a difference between them is attributable to intent
evolution rather than conversation length.

### Grading and run-failure separation

The native grader accepts one submission policy: the final non-empty line of
the agent's last message must be `FINAL_ANSWER: <integer>`, with exactly one
marker and a canonical integer. Grading produces one of two record kinds:

- **Verification** with verdict `pass`, `wrong` (well-formed but not the
  sealed answer), or `invalid` (malformed submission). All three are model
  behavior.
- **Run failure** with kind `agent` (the provider raised), `budget` (the
  declared budget is unusable), or `verifier` (grading authority was
  corrupt). These are infrastructure faults, not model behavior.

The separation matters for honesty in both directions: a malformed answer
counts against the model, and a provider timeout does not count for or
against it. Model pass rates use only verification outcomes as the
denominator; run failures are reported separately and propagate into the
identification bounds below.

### What the report states

For each (source, trial) unit the report takes the paired difference in pass
indicators, evolved minus matched, so the estimand lives in $[-1, 1]$.
Differences are averaged within each source task and then across source
tasks, so sources with more trials do not dominate. When either side of a
pair is a run failure, that unit contributes its worst-case and best-case
interval instead of a point value, which yields identification bounds for
the effect. A closed-form Hoeffding interval at 95% confidence, clustered by
source, widens those bounds for sampling error.

The report stops there. It states the point estimate, the interval, and the
interval's half-width — the minimum detectable effect, the smallest effect a
design of this size could have resolved. It does not convert those numbers
into a verdict. That half-width is $\sqrt{2\ln 40 / n}$ for $n$ source
clusters, so resolving even a 0.2 effect would take 185 sources against a
published admissible pool of 50; a verdict computed at any sample size this
harness can reach would report its own arithmetic rather than the evidence.
Interpreting the interval is left to the reader, who can see how wide it is.

## Run it yourself

The executable slice is offline and deterministic. Its test suite uses
real-shaped GSM8K rows and scripted chat callables, and needs no network,
provider keys, or GPU.

```bash
cd parallax
python -m pytest -q          # full offline suite; expect all tests to pass
python -m ruff check .       # lint; expect no findings
```

`tests/test_end_to_end.py` is the runnable walkthrough of the whole loop: it
builds script families, executes all three arms with scripted agents, writes
evidence JSONL, and checks report semantics including byte stability and the
identification bounds. `tests/conftest.py` shows how a family is constructed
from a raw GSM8K row. The programmatic entry points are
`runner.run_experiment` (families in, evidence JSONL out) and
`report.report_from_jsonl` (evidence in, report out).

## How findings are recorded and audited

One experiment writes one evidence JSONL file through atomic replacement,
with canonical sorted-key JSON so identical experiments are byte-identical.
It contains exactly three record kinds:

- one **manifest**, preregistering every (source, trial) unit with its seed,
  and content digests of the design, model configuration, and each arm
  configuration;
- one **family** record per source, holding the sealed answer, the extracted
  intent, all accepted and rejected construction attempts, and the three
  scripts — the sealed answer appears here exactly once and never in run
  rows;
- one **run** record per scheduled (source, trial, arm), holding the full
  transcript, final answer, outcome, and usage.

Reports are recomputed from the evidence file alone and validate before
aggregating: seed drift, configuration drift, duplicate or missing scheduled
rows, unknown arms, and malformed outcomes are hard errors with named
reasons. Shuffling the evidence rows must not change the report bytes.

Process-level auditing is layered on top. Chronological decisions and their
reversals live in [`../NOTES.md`](../NOTES.md), and `git log -- parallax`
gives the delivery trail. The first executable slice was gated by four
independent reviews before acceptance, and the same discipline applies to
future slices:

1. **Upstream algorithmic fidelity** against the published method and the
   immutable reference implementation commit, with every deliberate
   divergence documented in the method contract.
2. **Statistical soundness**, which replaced trial-level bootstrap inference
   with the preregistered manifest, source-clustered identification bounds,
   and the closed-form interval described above.
3. **Complexity**, which removed structure that did not pay for itself and
   recorded the simplifications that were rejected because they would weaken
   method or evidence fidelity.
4. **Behavioral mutation testing**, which mutated contract-bearing lines and
   required the test suite to kill every active mutant. The gauntlet is
   committed as `tests/test_mutation_gauntlet.py` and runs under
   `pytest -m mutation`; scores reported in reports dated before 2026-08-04
   came from gauntlets that were never committed and are not reproducible.

## Why it is built this way

The commitments above were not designed in one sitting. They descend from a
documented research phase, and each load-bearing choice has a citable origin.

- **The failure mode and the control discipline come from the literature.**
  ["LLMs Get Lost in Evolving User Intent"](https://arxiv.org/abs/2607.20734)
  observed the failure mode and pinned the construction algorithm Parallax
  reimplements; the [method contract](methods/evolving-intent.md) records the
  exact upstream revision consulted and every deliberate divergence.
  [SlopCodeBench](https://arxiv.org/abs/2603.24755) grounds the separate
  checkpoint-evolution strategy that [`MODEL.md`](MODEL.md) declares out of
  scope: its state machine (a workspace persisting across separately scored
  checkpoints) is incompatible with intent-trajectory state, which is exactly
  why the model fixes shared vocabulary and invariants while each strategy
  owns its own state machine. Collapsing them into one transformation algebra
  would erase the variables experiments must control. That decision is
  recorded in [`decisions/ADR-001.md`](decisions/ADR-001.md), and the exact
  papers and repository revisions it was checked against are pinned in
  [`decisions/LITERATURE-PINS.md`](decisions/LITERATURE-PINS.md).
- **Preregistration before outcomes.** Freezing the units, seeds, and
  configuration digests in the evidence manifest before any outcome is
  visible follows the preregistration rationale documented by the
  [Center for Open Science](https://www.cos.io/initiatives/prereg): planned
  tests must be distinguishable from later exploration, and analytical
  choices must not depend on observed results.
- **One vertical slice, learned from failed attempts.** Two earlier
  directions were built and deliberately stopped: a ten-variant-family
  contract catalog whose adversarial review concluded that typed schemas
  without one executable end-to-end path were premature complexity, and a
  content-addressed verifier core
  ([closed pull request](https://github.com/nikhil-vytla/hatch/pull/9)) that
  was over-engineered for the same reason. The current harness inverts the
  order: one complete journey first, with structure added only where a review
  demanded it. The architecture that replaced those directions was selected
  in a four-candidate arena; the winning base, accepted grafts, and
  rejections are preserved in
  [`decisions/DESIGN-SELECTION.md`](decisions/DESIGN-SELECTION.md).
- **Failure separation and budget matching encode prior review findings.**
  The rules that provider and harness faults must never count against the
  model, and that matched arms must equalize budgets rather than only turn
  counts, were explicit findings from the adversarial review of the earlier
  prototype, where hand-annotated failure notes and unmatched step budgets
  were caught confounding the measured effect. Both are now structural: run
  failures are typed rows validated by the report, and the primary contrast
  compares budget-matched arms only.
- **The four-review gate generalizes that experience.** Standing adversarial
  review of the prototype caught problems that authors of the code did not,
  so the harness now requires the four independent reviews above before a
  slice is accepted. The concrete changes each review forced are recorded in
  [`../NOTES.md`](../NOTES.md).

The decision records behind this section live in
[`decisions/`](decisions/README.md). The wider experimental archive — the
formal-model ancestor of `MODEL.md`, the complete literature review, the
arena candidate files, the typed knowledge base of source, concept, and
synthesis notes, the timestamped decision log, and the full adversarial
review — lives on the
[archive branch](https://github.com/nikhil-vytla/hatch/tree/cursor/hard-repo-tasks-5fc8/hard-repo-tasks)
of the superseded experiment that preceded this harness.

## Deliberately out of scope

- **Real-model evidence.** All existing runs use scripted agents. No claim
  about real agent behavior is supported yet; the harness exists so that the
  first real-provider run is already controlled and auditable.
- **Paper reproduction.** Upstream generated pools and provider transcripts
  are not published, so Parallax makes no byte-identical dataset, provider
  replay, or paper-score reproduction claims.
- **Other benchmarks.** GSM8K is the only implemented source pool. Harder
  benchmarks require their own adapters and admission checks.
- **Other strategies.** Checkpoint evolution is a separate strategy with its
  own unwritten state machine; it is not an Evolving Intent stage.
- **A command-line interface.** The entry points are the Python API and the
  test suite.

> **TODO:** Run the preregistered matched-versus-evolved contrast with one
> real model provider over a declared GSM8K sample, and report the point
> estimate, the interval, and the minimum detectable effect it achieved. An
> interval too wide to separate any plausible effect, or run failures that
> leave the identification bounds uninformative, forces a design revision
> before scaling.
