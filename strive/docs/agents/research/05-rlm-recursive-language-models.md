# 05 — Recursive Language Models (Alex Zhang)

## Provenance

- **Repo:** https://github.com/alexzhang13/rlm — cloned 2026-08-06 into a scratch
  directory (shallow clone, `--depth 50`). Exact commit:
  `72d6940142ddfb84ee6be573dc999a37e633e671` ("bump version", 2026-06-25), which
  is also tag `v0.1.3`; `pyproject.toml` declares `version = "0.1.3"`, published
  on PyPI as `rlms`. Caveat: tag `v1.0.0` (2026-01-12) is *older* than `v0.1.3`
  — the project renumbered its versions at some point, so tag names are not a
  chronology.
- **Blog post:** "Recursive Language Models", Alex L. Zhang,
  https://alexzhang13.github.io/blog/2025/rlm/ — dated October 2025. This is the
  original writeup that preceded the paper. Fetched 2026-08-06.
- **Paper:** "Recursive Language Models", Alex L. Zhang, Tim Kraska, Omar
  Khattab — arXiv:2512.24601 (https://arxiv.org/abs/2512.24601). v1: 31 Dec
  2025; v2: 28 Jan 2026; v3 (current, the version read here via the arXiv HTML
  rendering): 11 May 2026. 9 pages, 43 with appendix. MIT OASYS lab.
- **Linked material (recorded, not cloned):** minimal reference implementation
  at https://github.com/alexzhang13/rlm-minimal; project docs at
  https://alexzhang13.github.io/rlm/; RL-trained checkpoint
  `mit-oasys/rlm-qwen3-30b-a3b-v0.1` on Hugging Face (linked from
  `training/README.md`).
- **Availability caveats:** all URLs resolved on 2026-08-06 (no 404s). Repo
  code was read directly; blog and paper content was retrieved and summarized
  via web fetch of the pages above, so paper quotes below are cited to the
  fetched v3 HTML. No code from the repo was executed; no credentials used.

## Source-supported facts

Facts are labeled **[repo]**, **[blog]**, or **[paper]**.

### The core loop [repo]

- `RLM.completion(prompt)` (`rlm/core/rlm.py`) is a drop-in replacement for an
  LLM completion call. Per completion it spawns (a) an `LMHandler` — a
  multi-threaded localhost TCP server that proxies all LM API calls
  (`rlm/core/lm_handler.py`, wire protocol: 4-byte big-endian length prefix +
  JSON, `rlm/core/comms_utils.py`) — and (b) an environment (default
  `LocalREPL`). Both are torn down at the end unless `persistent=True`.
- The loop (up to `max_iterations`, default 30): send message history to the
  root LM → extract ` ```repl``` ` fenced code blocks
  (`find_code_blocks`, `rlm/utils/parsing.py`) → execute each block in the
  environment → append the assistant turn plus one user turn containing REPL
  output, tail-truncated at 20,000 chars per block (`format_iteration`,
  `rlm/utils/parsing.py`) → repeat.
- Termination is signaled *from inside the REPL*: the namespace contains an
  `answer` dict initialized to `{"content": "", "ready": False}`; setting
  `answer["ready"] = True` fires a callback (`_AnswerDict` in
  `rlm/environments/local_repl.py`) that surfaces
  `REPLResult.final_answer`. If the model rebinds `answer` to a plain dict, the
  scaffold detects and re-wraps it (`_restore_scaffold`).
- If iterations run out, `_default_answer` asks the LM to produce a best-effort
  final answer from the accumulated history (`rlm/core/rlm.py`).

### Context as environment [repo, paper]

- The prompt/context is **never placed in the root model's message history**.
  It is written to a temp file and loaded into the REPL namespace as
  `context_0` (aliased `context`) — `LocalREPL.add_context`. The root model's
  first user message contains only metadata: "Your context is a {type} of {N}
  total characters" (`build_rlm_system_prompt`, `rlm/utils/prompts.py`,
  computed by `QueryMetadata` in `rlm/core/types.py`). **[paper]** describes
  this as the root model seeing "constant-size metadata about the user prompt,
  like its length, a short prefix, and how to access parts of it."
- The system prompt (`RLM_SYSTEM_PROMPT` + `ORCHESTRATOR_ADDENDUM`,
  `rlm/utils/prompts.py`) instructs the model to "act as an orchestrator, not a
  solver": probe the context with code, plan a decomposition, push every
  long-context operation into sub-LM calls, and keep its own tokens for
  decisions. It encodes explicit budget heuristics in prose: ~100K chars per
  sub-prompt, ~20 prompts per batch, "fat-prompt small batches" over
  "tiny-prompt mega-batches."

### Recursion and sub-calls [repo]

- REPL globals expose four scaffold functions (`LocalREPL.setup`):
  `llm_query` / `llm_query_batched` (plain LM completions routed through the
  LMHandler socket) and `rlm_query` / `rlm_query_batched` (recursive sub-RLM
  calls via a `subcall_fn` callback).
- Depth control: `RLM(depth=0, max_depth=1)` by default. `RLM._subcall` spawns
  a child `RLM` at `depth+1`; when `next_depth >= max_depth` it degrades to a
  plain LM completion with no REPL (`_fallback_answer` / the no-REPL branch of
  `_subcall`). So recursion is bounded structurally, not by convention.
- Children inherit the parent's config but receive the **remaining** budget and
  timeout (`remaining_budget = max_budget - cumulative_cost`,
  `remaining_timeout = max_timeout - elapsed`, `rlm/core/rlm.py` `_subcall`);
  child spend is added back to the parent's cumulative cost. Exhausted budgets
  make the subcall return an error *string* as its response — errors are data
  the root model sees in the REPL, not exceptions that kill the run.
- Batched sub-RLM calls run in a thread pool bounded by
  `max_concurrent_subcalls` (default 4, `local_repl.py`); batched plain LM
  calls are bounded by `batch_max_concurrent` (default 16, `lm_handler.py`),
  with per-prompt failures isolated (`return_exceptions=True`; one failed call
  does not abort the batch).
- Model routing: the handler routes by explicit model name or by depth
  (`depth == 1` → `other_backend_client`), so sub-calls can use a cheaper model
  than the root (`LMHandler.get_client`).

### Runtime boundaries / isolation [repo]

- Environment taxonomy in `rlm/environments/base_env.py`: `BaseEnv` →
  `NonIsolatedEnv` (same machine) and `IsolatedEnv` (separate machine). Seven
  environments: `local`, `ipython`, `docker`, `modal`, `prime`, `daytona`,
  `e2b`.
- **`LocalREPL` (default) is in-process `exec()`** with a merged globals/locals
  namespace — no subprocess, no IPC for code execution. It removes dangerous
  builtins (`eval`, `exec`, `compile`, `input`, `globals`, `locals` →
  `_SAFE_BUILTINS`, `local_repl.py`) but keeps `open` and `__import__`.
  `docs/architecture.md` is explicit: "This is a soft sandbox — it prevents
  accidental misuse but is not a security boundary." (Note a doc inconsistency:
  the `NonIsolatedEnv` docstring claims the local REPL "runs as a subprocess";
  the code and architecture doc show it is in-process.)
- `IPythonREPL` can run in a separate `ipykernel` subprocess with hard
  `cell_timeout` and namespace isolation (`rlm/environments/ipython_repl.py`,
  README). `DockerREPL` runs code in a container fully isolated from the host,
  with a host-side HTTP proxy bridging `llm_query`/`rlm_query` back to the
  handler (`rlm/environments/docker_repl.py`). Modal/Prime/Daytona/E2B are
  cloud sandboxes; recursive sub-calls from isolated environments are requested
  from the host process (README).
- **Trusted-namespace enforcement:** `RESERVED_TOOL_NAMES` (`base_env.py`) —
  `llm_query`, `rlm_query`, their batched variants, `SHOW_VARS`, `answer`,
  `context`, `history` — cannot be shadowed by user tools (`validate_custom_tools`)
  and are **restored after every code execution** (`_restore_scaffold`,
  `local_repl.py`) so model code that overwrites `context = "x"` or
  `llm_query = ...` cannot corrupt the scaffold for later turns.
- Logged config is scrubbed with `filter_sensitive_keys`
  (`rlm/utils/rlm_utils.py`) before being written.

### Budgets and failure handling [repo]

- Five independent limits on a completion: `max_iterations`, `max_budget`
  (USD, needs a cost-reporting backend), `max_timeout`, `max_tokens`,
  `max_errors` (consecutive REPL-error iterations). Each raises a typed
  exception (`rlm/utils/exceptions.py`) that **carries `partial_answer`** — the
  best non-empty response seen so far — so callers can salvage a result.
  Ctrl+C raises `CancellationError`, also with the partial answer.
- REPL exceptions are caught and appended to `stderr` in the `REPLResult`
  (`local_repl.py execute_code`); the model sees its own tracebacks as
  observations. Consecutive-error tracking resets on any clean iteration.

### State, persistence, traces [repo]

- `persistent=True` reuses one environment across `completion()` calls
  (multi-turn): contexts and message histories accumulate as versioned REPL
  variables `context_N` / `history_N` with `context`/`history` aliases —
  formalized in the `SupportsPersistence` protocol (`base_env.py`), implemented
  by local/ipython/docker. Histories are deep-copied on store.
- **Compaction** (`compaction=True`): when root message history reaches
  `compaction_threshold_pct` (default 0.85) of the model's context limit, the
  LM writes a progress summary; the *full* trajectory segments and the summary
  are appended to the REPL variable `history`; the live message history is
  reset to system + metadata + summary + "continue" (`RLM._compact_history`).
  Nothing is lost — the model is told it can re-read `history` and use
  `SHOW_VARS()` to recover its position.
- `RLMLogger` (`rlm/logger/rlm_logger.py`) captures run metadata plus every
  iteration (prompt, response, code blocks, REPL results, per-call LM usage) in
  memory and optionally as an append-only JSONL file per run; the trajectory is
  attached to `RLMChatCompletion.metadata`, and child RLMs get their own logger
  so nested trajectories nest in the parent's metadata. A Next.js
  trajectory visualizer lives in `visualizer/`. Live-tree callbacks
  (`on_subcall_start/complete`, `on_iteration_start/complete`) are supported.
- All state is per-process/in-memory (plus optional JSONL logs and temp files);
  there is **no durable store, no ledger, no cross-run memory** in the
  inference engine.

### Evaluation and training [repo, paper, blog]

- **[repo]** The inference engine itself contains no evaluator — no scoring,
  acceptance, or selection machinery. Evaluation lives in `training/`: a
  `verifiers`-compatible `RLMTrainEnv` (`training/src/rlm_train/env.py`)
  mirrors `RLM.completion` at depth=1 for RL training with Prime Intellect's
  `prime-rl`. Each rollout gets its own subprocess REPL worker
  (`python -u -m rlm_train.worker`, `training/src/rlm_train/repl/subprocess.py`)
  and sub-LM calls are routed to the trainer's inference server via
  `SubLLMProxy` (`training/src/rlm_train/proxy.py`).
- **[repo]** `RLMTrainRubric` (`training/src/rlm_train/rubric.py`) = a
  user-supplied correctness reward plus *behavioral gates*: reward can be zeroed
  unless the rollout used at least `min_iterations` REPL turns and
  `min_subcall` sub-LM calls and cleared `min_reward` — i.e., reward shaping
  that forces the policy to actually use the harness. Monitoring metrics track
  iterations, REPL calls, sub-LM calls, and whether a final answer was
  submitted.
- **[repo]** Tests run offline against `tests/mock_lm.py` (`MockLM` with
  scripted responses/`response_fn`); real-model e2e tests are skipped unless
  `OPENROUTER_API_KEY` is set (`tests/test_e2e_depth.py`).
- **[blog]** (Oct 2025) Motivation: "context rot" — degradation of LM quality
  as context grows even within the window. Initial results with GPT-5 /
  GPT-5-mini: on OOLONG (132k tokens) RLM(GPT-5-mini) beat GPT-5 by ~34 points
  (~114% relative) at comparable cost; at 263k tokens, ~49% relative gain; on
  BrowseComp-Plus at 1000 documents RLM(GPT-5) stayed at ceiling while
  baselines collapsed. Depth 1 sufficed for these benchmarks. Emergent
  strategies observed in trajectories: peeking, grepping, partition-and-map,
  summarization. The blog explicitly frames the recursive trajectory as
  "entirely learnable, and can be RL-ified."
- **[paper]** (v3) Four benchmarks: S-NIAH, OOLONG, OOLONG-Pairs,
  BrowseComp-Plus. Headline numbers from the fetched HTML: BrowseComp-Plus 1K
  docs baseline ~0% vs RLM(depth=1) 91.3%; OOLONG-Pairs (quadratic pairwise
  reasoning) baseline 0.1% vs RLM(depth=3) 76%. Experiments used max depths
  0–3. Inputs processed "more than an order of magnitude beyond model context
  window limits." Cost: "RLMs remain in the same order of magnitude of cost as
  GPT-5"; high runtime/cost variance, but the median RLM run was cheaper than
  the median base-model run. RLM-Qwen3-8B: rejection fine-tuning on 1,000
  filtered trajectories from RLM(Qwen3-Coder-480B), each root turn a separate
  SFT sample, with programmatic trajectory corrections (16% had final-answer
  format errors, 13% misused REPL variables); median 28.3% improvement across
  the four tasks and >3× faster. Failure modes: models with weak coding
  ability fail as RLMs; answer-vs-thought disambiguation is brittle;
  sequential blocking sub-calls are slow. Future work: treat RLM training as
  "a new axis of scale," on-policy/online rollouts, asynchronous sub-calls,
  sandboxed REPLs.

## Analysis dimensions

### Runtime, task, environment, and state models

**[repo]** Runtime = one Python process per root RLM; per-completion TCP
LM-handler + environment pair; child RLMs are recursive in-process object
instantiations (threads for batched subcalls), not separate processes — except
code execution, which may be in-process (`local`), subprocess (`ipython`
kernel mode; training worker), or remote sandbox (docker/modal/prime/daytona/
e2b). Task model: a single completion over a (possibly huge) prompt; no task
suite, no benchmark runner in the engine. State model: REPL namespace
(variables persist across iterations within a completion, and across
completions when `persistent=True`) plus the message history. Environments are
selected by string key with kwargs (`get_environment`,
`rlm/environments/__init__.py`).

### Observation, trajectories, traces, memory, persistence

**[repo]** Observations returned to the model are stdout/stderr of its own
code, truncated at 20K chars/block, plus a list of existing REPL variable
names (`format_execution_result`). Trajectories: `RLMLogger` JSONL +
in-memory, nested through children, visualized in `visualizer/`. Memory within
a session: REPL variables as scratch buffers; compaction preserves the full
history inside the REPL while shrinking the model-visible window. **Durable
cross-run memory: not addressed by source** — nothing survives process exit
except optional log files, and logs are never read back by the system.

### Trusted/immutable vs evolvable surfaces

**[repo]** A real, mechanically enforced split exists, though the vocabulary
differs from strive's. Trusted: the loop (`rlm.py`), the handler, the limits,
the system prompt, and the eight `RESERVED_TOOL_NAMES` — enforced at tool
registration (`validate_custom_tools`) and re-asserted after *every* code
execution (`_restore_scaffold`), because the untrusted party (model code)
shares a namespace with the scaffold. "Evolvable" (better: ephemeral and
model-authored): everything else in the REPL namespace — the model's own code,
variables, and strategy per query. No model-authored artifact outlives the
completion. The trust boundary is per-turn namespace hygiene, not review.

### Recursive decomposition, subagents, context management (specialty)

This is the cluster's core contribution; going deep:

- **Context is an environment, not an input.** **[repo, paper]** The defining
  move is inverting the prompt relationship: the context lives *in* the
  execution environment as a first-class variable, and the root model receives
  only its type and size. The model must write code to observe it (slice,
  regex, count) — observation is an *act* with a cost, not a default. The
  paper adds that even stdout is metadata-limited: "it forces [the model] to
  rely on variables and sub-calls to manage long strings." The 20K-char
  truncation in `format_iteration` is the repo's enforcement of this.
- **Two-tier delegation vocabulary.** **[repo]** `llm_query` (cheap, one-shot,
  no REPL — for extraction/summarization over a chunk) vs `rlm_query` (a full
  child RLM with its own REPL — for subtasks needing iteration). The system
  prompt teaches when to use which. Sub-agents are *functions in code*, so
  decomposition strategies are ordinary programs: loops over chunks, branch on
  a sub-answer, staged coarse-then-fine passes. This is the "CodeAct-style,
  anti-JSON-tool-calling" bet stated in the README.
- **Depth control is structural.** **[repo]** `depth`/`max_depth` are plumbed
  through RLM → environment → LMRequest; at the cap, `rlm_query` silently
  degrades to a plain LM call rather than erroring. **[blog]** depth 1 sufficed
  for 2025 benchmarks; **[paper]** depth 3 was needed for the quadratic
  OOLONG-Pairs task — i.e., required depth tracks task combinatorics.
- **Cost.** **[repo]** Budgets/timeouts are *decremented down the recursion
  tree* (children get the remainder) and spend is aggregated back up;
  concurrency is capped at two levels (subcall threads, batch semaphore).
  **[paper]** Empirically same order of magnitude as a frontier-model call,
  with heavy variance; median cheaper than baseline. **[blog]** flags missing
  async and prefix caching as the main systems inefficiency.
- **Failure containment in recursion.** **[repo]** Every subcall failure —
  exception, exhausted budget, exhausted timeout — becomes an
  `"Error: ..."` string returned into the parent's REPL, so the orchestrating
  program can branch on failure like any other value.

### Candidate generation and self-modification

**[repo]** Not addressed by source in strive's sense. The model generates code
every turn, but it is throwaway orchestration code for the current query — it
is never scored against an incumbent, never retained, never versioned. There
is no proposer, no patching, no notion of an artifact improving over time.

### Evaluation, selection, promotion, rollback, lineage

**[repo]** Not addressed by the inference engine (no evaluator/selector at
all). In `training/`, evaluation exists as RL reward: correctness function +
gates on harness usage (`rubric.py`), and **[paper]** as offline trajectory
filtering (rejection fine-tuning keeps only good trajectories, with
programmatic repair of common defects). Promotion = gradient update / new
checkpoint; rollback and lineage: not addressed by source.

### Sandboxing, secrets, permissions, budgets, recovery

**[repo]** Sandboxing is a pluggable spectrum under one `BaseEnv` interface:
in-process soft sandbox (blocked builtins; explicitly not a security boundary)
→ ipykernel subprocess with cell timeouts → Docker with host-side LM proxy →
remote cloud sandboxes. Secrets: LM keys stay in the host process; sandboxed
code reaches models only through the socket/HTTP proxy, and logged config is
scrubbed (`filter_sensitive_keys`). Permissions: no allowlist beyond builtin
removal; `open`/`__import__` are available locally. Budgets: five typed limits
with partial-answer recovery; budget/timeout inheritance down the tree.
Recovery: partial answers on every limit exception; per-prompt failure
isolation in batches; consecutive-error threshold.

### Online adaptation vs offline optimization

**[blog, paper]** Everything adaptive at inference time is *within-query*
(strategy is re-derived from scratch each completion). Improvement across
queries is offline: SFT/RL on collected trajectories (paper's RLM-Qwen3-8B;
repo's `training/` harness). There is no online, between-run adaptation
mechanism. Not addressed: any system that adapts the harness itself online.

### Harness adaptation vs model-weight learning

**[repo, paper]** RLM takes the opposite branch from strive: the harness
(loop, prompts, budgets, REPL scaffold) is fixed and human-maintained; the
*policy weights* learn to use it better. The repo makes this concrete —
`training/` exists so the same scaffold serves as an RL environment
("Train your own RLMs, which directly can be plugged into our inference
engine!", README). The paper's rubric gates (`min_iterations`, `min_subcall`)
show they had to shape reward to force policies to use the harness at all.

### Genuinely self-improving vs merely persistent/configurable

**[repo]** The inference engine is neither: it is stateless-per-run and
configurable. **[paper]** The training pipeline yields real capability gains
(28.3% median for RLM-Qwen3-8B) but the improvement loop is human-operated
offline (collect → filter → repair → fine-tune), not autonomous. By strive's
charter definition (evidence-motivated, self-proposed, empirically validated,
durably retained with lineage), RLM is **not** self-improving — it is a very
good execution/decomposition substrate over which a self-improvement loop
could operate.

### Mechanisms suitable for a robust, long-lived harness

**[repo]** The transferable, production-quality mechanisms: (1) reserved-name
scaffold restoration after every untrusted execution; (2) typed limit
exceptions carrying partial results; (3) budget/timeout *inheritance* down a
delegation tree with cost aggregation back up; (4) errors-as-values at the
delegation boundary; (5) the `BaseEnv` isolation ladder behind one interface;
(6) per-completion socket LM-proxy so sandboxes never hold credentials; (7)
JSONL trajectory logging with nested child trajectories and a visualizer; (8)
offline test doubles for the model (`MockLM`); (9) compaction that summarizes
the visible window while retaining the full record in queryable storage.

## Interpretations

These are my inferences, not claims made by the sources.

1. **"Context as environment" generalizes to "evidence as environment."** The
   RLM insight is that anything too big or too structured to stuff into a
   prompt should become a typed variable in an execution environment plus
   metadata in the prompt. For strive, execution traces, ledgers, and case
   suites are exactly such objects. A diagnoser that *queries* traces
   programmatically should scale far past one that reads them inline — and it
   makes diagnosis cost explicit and budgetable.
2. **The `_restore_scaffold` pattern is a miniature trust boundary under
   continuous attack.** RLM assumes model code *will* clobber the scaffold and
   makes restoration unconditional and cheap, rather than trying to prevent it.
   That "re-assert invariants after every untrusted step" posture is more
   robust than validation-at-the-edges, and it foreshadows how strive should
   treat any shared surface between trusted loop and evolvable code.
3. **Degrade, don't refuse, at resource boundaries.** Recursion at max depth
   becomes a plain LM call; exhausted budgets become error strings; exhausted
   timeouts still return partial answers. The system has no cliff edges. This
   is a design stance (graceful capability degradation) that strive's charter
   ("every failure mode is a recorded outcome") states but RLM implements more
   pervasively.
4. **RLM quietly demonstrates why prompts are a high-leverage evolvable
   surface.** The behavioral heuristics that make RLM work — chunk sizes,
   batch widths, orchestrator discipline, turn-1 safeguard — live entirely in
   `prompts.py` prose and were clearly hand-tuned across versions (the file
   retains deprecated prompt generations). Those numbers (~100K chars/prompt,
   ~20/batch) are exactly the kind of parameters a strive-style loop could
   evolve against evidence instead of hand-tuning.
5. **The rubric gates are an anti-reward-hacking artifact worth stealing.**
   Zeroing reward unless the policy actually used ≥N iterations and ≥M
   sub-calls is a crude but effective guard against degenerate strategies that
   satisfy the scorer without exercising the intended mechanism — directly
   relevant to strive's research question 3.
6. **Depth-1 sufficiency is probably temporary.** The blog found depth 1
   enough; the paper already needed depth 3 for quadratic tasks. Inference:
   recursion depth requirements grow with task compositionality, so a harness
   should treat depth as a per-task budget, not a global constant.

## Hypotheses to test in strive

1. **Trace-as-variable diagnosis:** a diagnoser given traces as queryable data
   (REPL-style: filter, count, slice, sub-LM over selected failures) finds
   non-planted weaknesses that a fixed-prompt diagnoser misses, at equal or
   lower token cost. Testable at stage 2 with the fake-model adapter.
2. **Metadata-only exposure reduces overfitting pressure:** if the proposer
   sees case *metadata* (counts, failure signatures, representative examples)
   rather than the full validation suite verbatim, accepted candidates
   generalize better to held-out cases (less suite memorization).
3. **Budget inheritance makes validation cost self-limiting:** giving each
   propose→validate cycle a decrementing budget that children inherit (RLM's
   `remaining_budget` pattern) keeps total cost bounded even when validation
   fans out, without a global scheduler.
4. **Reward-style gates catch degenerate proposals:** acceptance rules that
   require *mechanism use* (e.g., candidate must differ from incumbent on
   diagnosed failing cases, not only on aggregate score) reject
   score-satisfying-but-vacuous changes that plain "no regressions" accepts.
5. **Scaffold re-assertion beats scaffold protection:** re-imposing invariants
   on the evolvable surface after every cycle (re-validating the strategy file
   exports `solve()`, re-pinning the runner contract) is cheaper and more
   reliable than trying to prevent candidates from violating them.
6. **Partial-results-on-limits improves evidence quality:** recording a
   best-so-far output when a candidate times out (instead of only "timeout")
   gives diagnosis materially more signal about *why* it hung.

## Mechanisms: early prototype vs mature harness

**Adopt now (strive stage 2):**

- Typed limit exceptions carrying partial results (`exceptions.py` pattern) at
  the sandbox boundary — cheap, and improves trace evidence immediately.
- `MockLM`-style deterministic model double behind the `ModelAdapter` protocol
  — RLM's tests prove this keeps a model-shaped system fully offline-testable.
- Errors-as-values at every delegation boundary: evaluator/proposer failures
  become recorded outcomes in the ledger, never exceptions that kill the loop
  (strive's charter already demands this; RLM shows the concrete shape).
- Budget fields on the cycle (`max_budget`, `max_timeout`, `max_tokens`,
  `max_errors`) with per-stage decrement — before models arrive, so the
  interfaces are budget-aware from day one.
- JSONL trajectory logging of all proposer I/O with nested sub-call records
  and secret scrubbing (`RLMLogger` + `filter_sensitive_keys` pattern) —
  matches HANDOFF item 4 exactly.

**Adopt later (stages 3–6):**

- The `BaseEnv` isolation ladder: one environment interface with local /
  subprocess-kernel / container / cloud-sandbox implementations, chosen per
  trust level of the candidate. This *is* strive's stage-6 sandbox roadmap;
  RLM's `docker_repl.py` host-proxy design (sandbox never holds API keys,
  all model access brokered over a socket) is the reference architecture.
- Evidence-as-environment diagnosis (full REPL over traces) — needs a real
  model in the loop to pay off; premature at stage 2.
- Recursive delegation (`rlm_query`-style child loops with inherited budgets
  and structural depth caps) — strive stage 5's "recursive delegation to
  sub-agents."
- Compaction with full-history retention in queryable storage — relevant once
  strive has long-running model-backed cycles whose own context grows.
- RL/SFT on harness trajectories (the `training/` pattern) — a stage-6+
  complement: once the harness generates good trajectories, they become
  training data for cheaper local models, which is model-weight learning and
  therefore outside strive's current non-goals.

## Implications for strive — concrete interface/design consequences

1. **`Diagnoser` should receive a handle, not a payload.** Define the stage-2
   diagnosis interface as `diagnose(evidence: EvidenceStore) -> Weakness`
   where `EvidenceStore` offers query methods (failing cases, error classes,
   timings) — not `diagnose(traces: list[Trace])`. This keeps the door open
   for RLM-style programmatic evidence exploration without changing the
   interface when models arrive, and it makes the "metadata-only exposure"
   hypothesis testable by policy rather than by refactor.
2. **Add budget plumbing to the cycle contract now.** Every stage call takes a
   `Budget` (tokens/USD/seconds remaining) and returns spend; `run_cycle`
   decrements. RLM shows the inheritance arithmetic is trivial if designed in
   and painful to retrofit across a recursion tree.
3. **`RunResult` should carry `partial_output` and typed failure kinds.**
   Extend the strategy-runner result so timeout/crash outcomes can still carry
   whatever the candidate produced — mirrors `partial_answer` and enriches
   diagnosis evidence.
4. **Make sandbox tiers a registry behind one protocol.** `sandbox.py` should
   expose the same interface whether the implementation is `python -I` +
   timeout (today), rlimit-subprocess (stage 2 threat model), or container
   (stage 3+), selected per candidate provenance — directly adopting the
   `BaseEnv` / `get_environment` shape, including the rule that only the
   trusted side ever holds credentials and brokered channels carry model
   access into the sandbox.
5. **Re-assert evolvable-surface invariants after every acceptance.** Add an
   explicit post-accept validation step (module exports `solve()`, no imports
   outside allowlist, file parses) that runs unconditionally each cycle —
   the `_restore_scaffold` posture applied to strategy files.
6. **Acceptance rules should include mechanism-use gates.** Alongside
   "improves score, no regressions," require the candidate to change behavior
   on the diagnosed failing cases specifically (RLM's rubric-gate pattern) —
   a cheap first defense against evaluation overfitting for model-backed
   proposers.
7. **Journal nested model calls hierarchically.** When proposers gain sub-calls
   (stage 5), the ledger's event stream should nest child trajectories under
   the parent event, as `RLMLogger` nests child RLM metadata — otherwise
   lineage under recursive delegation becomes unreconstructable.
8. **Prompts-as-evolvable-surface has empirical support here.** RLM's behavior
   is substantially determined by hand-tuned prompt constants (chunk/batch
   budgets, orchestrator rules). When strive opens the prompt surface (stage
   3), these are precisely the parameter-shaped prompt fragments to evolve
   first, since they have measurable behavioral consequences.
