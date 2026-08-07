# 01 — Let the Model Write the Code (cmpnd.ai)

## Provenance

Retrieved 2026-08-06.

- **Primary source:** https://www.cmpnd.ai/blog/let-the-model-write-the-code.html —
  "Introducing Flex: Let the Model Write the Code", guest post by Michael Isaac
  (PhD student in software engineering, CMU), published 2026-08-05 on the cmpnd
  blog. Fetched successfully; content below quoted from the live page.
- **Load-bearing linked sources, also fetched and read:**
  - https://dspy.ai/diving-deeper/flex/ — DSPy `Flex` module documentation.
  - https://dspy.ai/api/optimizers/GEPA/overview/ — DSPy GEPA optimizer docs.
  - https://arxiv.org/abs/2507.19457 — "GEPA: Reflective Prompt Evolution Can
    Outperform Reinforcement Learning" (Agrawal et al., 2025), the paper GEPA
    implements.
  - https://www.cmpnd.ai/blog/separating-task-from-model.html — companion cmpnd
    post the article links to for its framing ("define a task once … let it be
    re-implemented as the AI ecosystem advances").
  - https://www.dbreunig.com/2025/06/10/let-the-model-write-the-prompt.html —
    Drew Breunig's earlier talk/post whose title this post riffs on; source of
    the conflation task lineage.
- **Availability caveats:** pages were retrieved through a fetch tool that
  converts to markdown and extracts content via a model; short passages marked
  as quotes were returned as verbatim extracts, but I could not diff against
  raw HTML. Optimization wall-clock time/cost and any human-review process for
  generated code were not surfaced by extraction — treated as not addressed.
  Author-page links (Agrawal, Lee, Zhang) were noted but not fetched.

## Source-supported facts

**What Flex is.** Flex is a DSPy module whose *implementation source code* is
an optimizable parameter. "What makes Flex different is what it exposes to an
optimizer: `Flex` exposes its code, in addition to its instructions." It is a
drop-in swap for a fixed module: `dspy.Predict(sig)` → `dspy.Flex(sig)`. Per
the DSPy docs: "You give it a signature; it starts as a `dspy.Predict` or
`dspy.RLM` baseline; and `dspy.GEPA` rewrites its entire implementation." The
module's state is a read-only `module_src` string containing one
`dspy.Module` subclass; internal predictors are "derived from the code, and
each `forward` reconstructs them from the bound source."

**Sandboxing.** "Code written by a model is still untrusted code, so by
default **it never runs in your process**. Flex executes the generated source
inside a sandboxed interpreter." Only a curated set of primitives crosses the
boundary (core DSPy modules, string-form signatures, provided tools by name);
"values cross as JSON"; host objects, adapters, settings, evaluators,
optimizers, and nested Flex instances do not cross. Output fields are "parsed
against \[their\] annotation on the way out" so a Flex is type-identical to
the Predict it replaces. `max_predictor_calls` (default 100) caps sandboxed
predictor invocations per forward "against runaway loops". The
`interpreter_factory` must be "a zero-argument callable returning a fresh
`CodeInterpreter`" so parallel evaluations get isolated sandboxes.

**How optimization works.** "Hand a Flex module to `dspy.GEPA` and the
reflection model might decompose your program, write helper functions,
implement routing logic, *and* rewrite your prompts." GEPA treats Flex code as
a component distinct from instruction components; its code proposer receives
"the signature, any available tools, a catalog of allowed primitives, the
current source, and a batch of failing examples" and returns a revised module
class. Predictors inside a Flex are "owned by its code, not tuned in
parallel." GEPA itself (arXiv:2507.19457) "samples trajectories (e.g.,
reasoning, tool calls, and tool outputs) and reflects on them in natural
language to diagnose problems, propose and test prompt updates, and combine
complementary lessons from the Pareto frontier of its own attempts"; it
maintains a frontier of non-dominated candidates for "both exploration and
robust retention of complementary strategies", uses metrics that return
`dspy.Prediction(score=..., feedback=...)` with textual feedback, and runs
under an explicit evaluation budget (`max_metric_calls` / `auto`). The paper
reports GEPA beating GRPO by ~6% average with up to 35× fewer rollouts.

**Failure handling during optimization.** Candidate code that fails to parse
"scores the whole batch at the failure score"; runtime crashes are scored per
example — "each crashed example is scored at the failure score in its own
slot, by example index" — preserving alignment for GEPA's bookkeeping. Bad
candidates are outcomes, not exceptions.

**Case study (location conflation).** Task: decide whether two place listings
refer to the same physical location. Baseline: 90.4% accuracy at $0.98 per
1,000 records. With Flex + GEPA (metric with cost penalty λ; reflection LM
`claude-opus-5`, task LM `claude-haiku-4-5`, `max_metric_calls=400`):

| λ | Accuracy | LM calls/record | Cost/1k | Latency |
|---|----------|-----------------|---------|---------|
| 0 | 95.0% | 0.25 | $0.70 | 1,155 ms |
| 0.2 | 91.7% | 0.08 | $0.09 | 135 ms |
| 0.4 | 92.1% | 0.004 | $0.01 | 65 ms |

The generated program is a three-stage pipeline — normalize (strip franchise
numbers, legal suffixes, ~40 generic business words), compare (fuzzy token
similarity; addresses parsed into house numbers and street cores), decide
(rule-based logic over name verdict, address, geographic distance). "Only
when *none* of the 'Decide' rules fire … does the record go to the model" —
75% fewer LLM calls at λ=0; at λ=0.4 the model was called once across 240
test records.

**Four recurring optimization patterns** (verbatim from the post): "1.
**Decomposition.** Noticing that a task has steps (parse, normalize, compare,
decide) and giving each step its own implementation. 2. **Method selection.**
Choosing, for each step, between deterministic code and a model call, and
picking the right module … when it's a call. 3. **Routing.** Recognizing that
different *inputs* are different tasks: clear cases down the cheap path,
ambiguous ones to the judge. 4. **Evolution.** Once the structure settles,
refining what's inside it: the signatures and instructions of the decomposed
parts, and the code itself."

**Framing.** The closing argument is continuous re-optimization: teams
"continually compile our harness, balancing what's written as code and what's
handed off to an LM, as new data, models, and tactics arrive." The companion
post argues a task is fully specified by (1) a signature ("what should
happen"), (2) deterministic code for hard constraints ("what must happen"),
and (3) examples and metrics ("what does good look like"), with everything
below that line "left completely free to evolve." Breunig's antecedent post
supplies the slogan lineage: "Don't program your prompt. Program your
program."

**Persistence.** Serialization captures only `module_src` plus module-level LM
config; the interpreter "is not serialized" and is reconstructed at load time.

## Analysis dimensions

- **Runtime, task, environment, and state models.** Runtime: a host process
  (DSPy) plus a sandboxed interpreter per Flex forward; generated code runs
  only in the interpreter, with predictor/tool calls bridged back to the host.
  Task model: a DSPy signature (typed input/output spec) plus a train/val set
  and a metric returning score + textual feedback. State: the candidate's
  entire program state is one source string (`module_src`); everything else is
  reconstructed from it. No persistent environment beyond that.
- **Observation, trajectories, traces, memory, persistence.** GEPA's learning
  signal is structured execution traces — "inputs, outputs, failures,
  feedback", including "evaluation logs, code traces, failed parses,
  constraint violations, error message strings" — reflected on in natural
  language. Persistence is minimal: only the winning source is serialized;
  candidate genealogy and per-instance scores are retained only if
  `track_stats=True`, and the optimizer's history is not a durable runtime
  ledger. No cross-run memory surface. Append-only journaling, replay, and
  audit are not addressed by source.
- **Trusted/immutable vs evolvable surfaces.** Sharply present, in strive's
  sense. Trusted: the signature, the metric, the sandbox boundary, the primitive
  catalog, `max_predictor_calls`, the GEPA controller, the train/val data.
  Evolvable: the module source (structure, helper functions, routing logic) and
  the instructions inside it — and notably the *code/model boundary itself* is
  inside the evolvable surface (method selection). The evaluator is never
  evolvable.
- **Recursive decomposition, subagents, context management.** Decomposition is
  the #1 observed optimization pattern, but it is decomposition *of the
  generated program into steps*, not delegation to autonomous subagents.
  Nested `Flex` instances are explicitly unavailable in the sandbox, so
  recursion of the evolvable unit is prevented by construction. Agentic
  context management is not addressed by source.
- **Candidate generation and self-modification.** Model-generated whole-module
  rewrites: a reflection LM receives the current source, the signature, tools,
  the allowed-primitive catalog, and a batch of *failing examples*, and
  returns a revised module class. This is evidence-conditioned regeneration
  (closer to "rewrite" than to strive's bounded textual patch). The system
  modifies its program, never the optimizer or metric — self-modification is
  confined to one declared artifact.
- **Evaluation, selection, promotion, rollback, lineage.** Evaluation: metric
  over train/val sets under an explicit call budget. Selection: Pareto
  frontier of non-dominated candidates sampled "proportional to their coverage
  of validation instances" — a population mechanism, not incumbent-vs-champion.
  Promotion: `compile()` returns the best program at the end; there is no
  online promotion gate, no "no regressions" rule (Pareto retention plays that
  role during search). Lineage: candidate genealogy exists inside a GEPA run
  (`track_stats`) but is an optimizer artifact, not a durable ledger. Rollback:
  not addressed by source (trivially possible since a candidate is one source
  string, but no mechanism is described).
- **Sandboxing, secrets, permissions, budgets, recovery.** The strongest part
  of the source. Untrusted-by-default stance; out-of-process interpreter;
  allowlisted primitive catalog; JSON-only value crossing; type enforcement at
  the boundary; per-forward predictor-call cap; fresh interpreter per parallel
  evaluation; parse/runtime failures scored rather than raised. Budgets exist
  at two levels: optimization budget (`max_metric_calls`) and runtime budget
  (`max_predictor_calls`, plus cost as a first-class metric term λ). Secrets
  handling is not addressed by source; OS-level isolation strength of
  `PythonInterpreter` is not specified.
- **Online adaptation vs offline optimization.** Offline. GEPA compiles
  against a fixed train/val set; the artifact is then deployed frozen. The
  post's "continually compile … as new data, models, and tactics arrive"
  envisions *periodic re-compilation*, not within-deployment adaptation.
  (GEPA's `track_best_outputs` inference-time-search mode is a partial
  exception but selects outputs, not programs.)
- **Harness adaptation vs model-weight learning.** Entirely harness-side, and
  explicitly argued as superior for adaptation: the GEPA paper's thesis is
  that "the interpretable nature of language often provides a much richer
  learning medium … compared to policy gradients derived from sparse, scalar
  rewards," beating GRPO with up to 35× fewer rollouts. Weights are never
  touched; the same task definition is re-compiled when models change.
- **Genuinely self-improving vs merely persistent/configurable.** Within a
  compile run, this meets most of strive's "learning from itself" definition:
  changes motivated by its own traces, produced by its own proposal mechanism
  on a declared surface, validated empirically under a budget. What it lacks
  for *genuine* ongoing self-improvement: durable lineage across runs, online
  operation, and any accumulation of knowledge between compiles — each
  `compile()` is a fresh episode whose only survivor is the winning source.
- **Mechanisms suitable for a robust, long-lived harness.** Transferable:
  (1) code-as-the-genome with the whole candidate serializable as one source
  artifact; (2) allowlisted primitive catalog defining what generated code may
  touch; (3) type enforcement at the sandbox boundary; (4) failure-as-score
  (parse failure → batch failure score; per-example crash → per-slot failure
  score); (5) metrics that return score *plus textual feedback* to drive
  diagnosis; (6) Pareto-frontier retention instead of single-incumbent
  hill-climbing; (7) explicit evaluation budgets; (8) cost/latency as metric
  terms (λ) so the optimizer discovers deterministic routing; (9) "predictors
  owned by the code" — no tuning of sub-components that a structural rewrite
  will destroy.

## Interpretations

Inferences mine, not the source's:

1. **Flex is strive's stage-2/3 target built by someone else, minus the
   ledger.** It has model-generated code proposals, subprocess-style
   isolation, empirical validation, and budget discipline — but no durable
   journal, no rollback semantics, no online loop. The delta between Flex and
   strive's charter is almost exactly strive's trusted-surface machinery
   (ledger, activation pointer, replayability), which suggests that machinery
   is the differentiated part of strive, not the propose/validate mechanics.
2. **Whole-module rewrite vs bounded patch is a real fork in design space.**
   GEPA regenerates the entire module from (current source + failing
   examples) rather than applying minimal diffs. The reported wins
   (restructuring into normalize/compare/decide, inventing routing) are
   *structural* — unreachable by strive's current single-textual-patch
   proposer. Conversely, whole rewrites make credit assignment (charter RQ5)
   harder: one accepted candidate can change many things at once. GEPA
   sidesteps this via population + per-instance Pareto bookkeeping instead of
   per-change attribution.
3. **The most surprising empirical result is that evolution removes the model
   from the loop.** Given a cost penalty, the optimizer converged on mostly
   deterministic code with the LM as a fallback judge (1 call in 240 records
   at λ=0.4, at accuracy parity). Self-evolution here is not "make the agent
   smarter" but "compile intelligence into cheap code and reserve the model
   for residual ambiguity." That is a distinct improvement axis (efficiency)
   strive's exact-match scoring cannot currently express.
4. **Textual feedback is the diagnosis interface.** GEPA's metric contract
   (`score` + `feedback` string) is effectively strive's diagnose stage
   collapsed into the evaluator: the "diagnosis" is free-form language
   consumed by the reflection LM, rather than a typed weakness from a
   signature registry. This trades auditability for generality.
5. **Validation-set overfitting is handled socially, not mechanically.** GEPA
   selects on a val set it also uses for frontier bookkeeping; the post
   reports test-set numbers, implying a held-out test split exists in the
   experiment, but nothing in the mechanism *enforces* held-out acceptance.
   strive's planned visible/held-out split is stricter than what this source
   practices.
6. **Sandbox realism.** The Flex sandbox is a language-level interpreter
   boundary with an allowlist — stronger in interface design than strive's
   `python -I` (catalog + JSON crossing + type gate) but its OS-level strength
   is unstated; I would not assume it exceeds fault isolation either.

## Hypotheses to test in strive

1. **Feedback-rich metrics beat signature registries for generality.** If
   strive's evaluator returns per-case textual feedback (error strings, failed
   parses, diffs) and the model proposer consumes it, a non-planted weakness
   on a second task gets fixed without any registry entry. Test directly in
   the stage-2 milestone.
2. **Whole-strategy rewrite vs bounded patch.** Run both proposers on the same
   diagnosed weakness under identical budgets: does rewrite find structural
   wins (decomposition/routing) that patching cannot, and does it regress
   held-out cases more often? Measure acceptance rate, regression rate, and
   score delta.
3. **Cost-in-the-metric induces routing.** Add an efficiency term (λ ×
   model-calls or wall-time) to strive's scoring once tasks involve model
   calls: does evolution discover "deterministic first, model fallback"
   structure as it did in the conflation study?
4. **Pareto retention vs single incumbent.** Keep k non-dominated generations
   active-eligible (per-case coverage), sampling parents from that frontier:
   does it escape local optima that strictly-better-than-incumbent acceptance
   blocks (charter RQ2), without letting regressions through?
5. **Failure-as-score robustness.** Adopt the parse-fail → floor-score,
   per-case-crash → per-slot floor-score convention and verify the loop
   survives arbitrarily malformed model-generated candidates with no
   controller exceptions (charter reliability attribute).
6. **Few-rollout sufficiency.** GEPA claims large gains from few rollouts
   because language feedback is dense. Test whether strive cycles with n≤5
   validation runs per candidate suffice when feedback is textual, versus
   needing many seeds when feedback is scalar-only.

## Mechanisms: early prototype vs mature harness

**Adopt now (stage 2, current redesign):**
- Metric contract `(score, feedback-text)` — make `evaluate` return per-case
  textual evidence; feed it to the proposer. Cheap, and it is the exact
  interface the strongest published result (GEPA) runs on.
- Failure-as-score conventions for candidates (parse failure, per-case crash)
  — strive already records outcomes, not exceptions; align the scoring
  semantics.
- Proposer input schema copied from Flex's code proposer: (current source,
  task signature, allowed-primitive catalog, batch of failing cases). The
  *catalog* is the piece strive lacks: an explicit allowlist of what generated
  strategy code may import/call, checked at validation time.
- Journal proposer I/O (already planned) — note GEPA does not do this
  durably; it is strive's differentiator, keep it.
- Explicit evaluation budget per cycle (`max_metric_calls` analogue).

**Defer to mature harness (stages 3–5):**
- Pareto-frontier population with per-case coverage bookkeeping and lineage
  merging — needs the composite-generation ledger work first (HANDOFF risk:
  "lineage under multiple surfaces").
- Whole-module structural rewrite as a competing evolution strategy alongside
  bounded patch (stage 3 "more than one evolution strategy … competes").
- Cost/latency terms in scoring and evolved routing — meaningful only once
  tasks contain model calls (stage 4 efficiency budgets).
- Interpreter-style sandbox with JSON-only crossing and boundary type
  enforcement — the stage-3/6 isolation mechanism; `python -I` + rlimits
  suffices until proposals are model-generated, which is imminent, so begin
  the threat-model now as HANDOFF item 5 says.
- Periodic re-compilation against new models ("continually compile the
  harness") — an offline maintenance loop distinct from, and complementary
  to, stage-5 online adaptation.

## Implications for strive

1. **`Proposer` protocol shape.** Define
   `propose(source, task_signature, catalog, failing_cases, feedback) ->
   candidate_source` — i.e., the proposer returns a *complete strategy file*,
   with the registry proposer internally applying its patch and returning full
   source. This makes bounded-patch and whole-rewrite proposers
   interface-identical, keeps the ledger's one-source-per-generation model,
   and matches Flex's proven proposer contract.
2. **Candidate = one source artifact.** Flex validates strive's existing
   choice: the entire evolvable state serializes as a single source string,
   reconstructed on load. Preserve this invariant even when prompts/policies
   become evolvable — embed them in the artifact or give each surface its own
   artifact, never hidden state.
3. **Add an allowed-primitive catalog to the trusted surface.** A declared
   allowlist (imports, callables, and later tool names) that candidate
   strategies may use, enforced at validation. It is simultaneously a safety
   boundary and — passed to the proposer — a generation constraint. This is a
   new trusted component (`catalog.py` or a `Task` field).
4. **Evaluator emits evidence, not just scores.** Extend `evaluate` so each
   case yields `(score, feedback_text)`; `diagnose` for model proposers
   becomes selection/summarization of that feedback rather than signature
   matching. Keep the signature registry as the deterministic implementation
   of the same interface.
5. **Type-enforce the strategy boundary.** Parse/validate `solve()` output
   against the task's declared output annotation at the runner boundary (Flex
   does this per output field), so wrong-type output is a scored, typed
   failure mode.
6. **Acceptance rules: plan for frontier, not just incumbent.** Keep
   strictly-better-plus-held-out acceptance for v0, but design the ledger's
   activation semantics so "active" can later be a *set* (Pareto frontier with
   per-case coverage) rather than a single pointer — an argument for
   activation entries carrying scope/coverage metadata now.
7. **Efficiency is an evolvable objective.** Make scoring a property of the
   `Task` (already in tech debt) and allow multi-term scores (quality + cost),
   because the headline result of this source is that evolution under a cost
   term produces qualitatively different — cheaper and *better* — programs.
8. **What strive keeps that this source lacks:** durable append-only lineage,
   journaled rollback, replayable model I/O, and online operation. Nothing in
   Flex/GEPA replaces these; they are strive's contribution, layered around a
   propose/validate core this source shows working at real scale.
