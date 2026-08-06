# 06 — labs-oo-agents (NVIDIA NeMo)

## Provenance

- **Repo:** https://github.com/nvidia-nemo/labs-oo-agents (canonical casing:
  `NVIDIA-NeMo/labs-OO-Agents`). Public, Apache-2.0. Clones successfully.
- **Commit examined:** `bfb347bca53c1eaa0449d7acfebdefb29075fc23`
  (merge of PR #91, 2026-08-05). Shallow clone (depth 50) into
  `/tmp/strive-research/labs-oo-agents`; retrieved **2026-08-06**.
- **What it is:** "NOOA" (NVIDIA-labs OO Agents), a model-agnostic Python
  framework for building agents as Python objects. PyPI package `nooa`, plus
  workspace packages `nooa-cli`, `nooa-memory`, `nooa-bench` and an unpublished
  `util/eval_pipeline`. Companion paper arXiv:2607.20709 (per `README.md`; the
  paper itself was not fetched — all claims below are from the repo).
- **Availability caveats:** `CHANGELOG.md` says "Initial public release"; the
  README references release tag `v0.0.7`. Young public repo; APIs may move.
  All source inspection was offline; nothing in the repo was executed.

## Source-supported facts

Everything in this section was verified directly in the checked-out source.
Paths are relative to the repo root.

**Core model — agents are Python objects** (`README.md`, `AGENTS.md`,
`src/nooa/agent.py`, `src/nooa/metaclass.py`):

- A class subclasses `Agent`; typed fields are state, ordinary methods are
  deterministic tools, and methods whose body is `...` are **generation
  methods** implemented at runtime by an LLM-driven strategy. The docstring is
  the prompt; the signature and return type annotation are the contract
  (Pydantic-validated structured output with auto-retry).
- Visibility is "visible by default, hide explicitly" (`@hidden`,
  `Annotated[T, hidden]`, `with hidden:`), documented in `AGENTS.md` with a
  table; module-level names flow into the code-execution namespace
  (`exec_globals`).

**Execution strategies** (`src/nooa/strategies/`): `predict.py` (direct
generation), `pure_python.py`, `codeact.py` (~2,900 lines) and
`codeact_lite.py` (LLM acts by writing Python cells in a Jupyter-style REPL
with access to `self`; a `return_result()` call raises an internal
`ExecutionSignal` to end the loop), `reflexion.py`, `prefill.py`,
`template.py`, `composite.py`. Strategies are attached per-method via a
`@strategy(...)` decorator (`src/nooa/decorators.py`).

**Self-critique loop** (`src/nooa/strategies/reflexion.py`): a composite
strategy that runs a base strategy, then asks the LLM for a structured
`ReflectionOutput` (`is_satisfactory`, `issues`, `suggestions`, `reasoning`);
if unsatisfactory it appends a formatted `Feedback` event and reruns, up to
`max_iterations` (default 3, `src/nooa/config/strategy_config.py` line 186).
After exhaustion it returns the last result with a warning — best-effort, not
gated.

**Generated-code validation — explicitly *not* a security boundary**
(`src/nooa/runtime/code_validator.py`, ~1,700 lines;
`src/nooa/runtime/restrictions.py`): a `UnifiedCodeValidator` runs static AST
checks over every generated cell with a documented error-code registry
(E001 forbidden builtins like `exec`/`eval`/`__import__`; E002 restricted or
blocked imports; E003 star imports; E004 recursive self-calls; E005 process
termination; E101/E102/E104 dunder/`setattr` escapes; E301 missing `await`;
E303 `while True` without break; E310 blocking calls that freeze the event
loop; E401/E402 class-attribute mutation; E501 return-type shadowing). The
module docstring states plainly: "These validators are **guardrails, not a
security boundary** … Do not treat the deny-lists as a jail … The actual
containment boundary is OS-level isolation." The README repeats this in a
prominent safety note and recommends running inside a container/VM.

**OS-level sandbox backend** (`src/nooa/runtime/sandbox/`): opt-in
(`CodeActConfig.execution_backend == "sandbox"`,
`src/nooa/config/strategy_config.py` line 80). A per-session worker process is
forked; the *child installs irrevocable kernel restrictions on itself* before
running any cell (`guards.py`, raw `ctypes` syscalls, no third-party deps):
Landlock path-beneath rules for default-deny filesystem, seccomp-BPF denying
`socket(AF_INET/AF_INET6)`, and `RLIMIT_AS`/`RLIMIT_CPU` with soft == hard.
The parent enforces a hard wall-clock timeout (SIGKILL past
`cell_timeout + timeout_grace_s`) and restarts the worker on timeout/CPU
kill/crash (`executor.py`). `check_enforceable()` probes host capabilities and
**fails closed** — Linux-only; unenforceable guardrails are reported, not
silently skipped. `SandboxConfig` defaults are the minimal-safe posture:
filesystem confined, network off, memory/CPU caps opt-in (`config.py`).
`self.*` calls from sandboxed cells are **brokered back to the live agent in
the parent process** with their own timeout so agent state stays out of the
worker (`executor.py` docstring, `config.py` `broker_timeout_s`).

**Method invariants** (`src/nooa/strategy_validation.py`): pre/postcondition
hooks around generated methods; a postcondition raising `InvariantError` is
"model-correctable" — routed back to the LLM through the validation-retry
feedback channel rather than crashing the call. Validation errors generally
are formatted into actionable LLM feedback (`src/nooa/strategies/codeact_errors.py`).

**Self-extension — three escalating levels of agent-authored code**
(`skills/nooa-self-extending/SKILL.md`, `src/nooa/tools/method_writing_lib.py`,
`src/nooa/tools/library_writing_lib.py`, `src/nooa/library_manager.py`):

1. In-cell helper `def`s — REPL locals, gone after the call.
2. Standalone `@strategy` async functions (`src/nooa/standalone.py`) — LLM-
   powered sub-calls that run on a fresh agent stub (no shared state, history
   discarded after the call).
3. **Persistent libraries**: the agent scaffolds real Python packages under a
   `libs/` directory (`self.libs.create(name, description)`), writes source via
   the shell skill, then `self.libs.reload(name)` lints and hot-reloads the
   package as `self.<lib_name>`, and `self.libs.run_tests(name)` runs pytest on
   the library's `tests/`. Lint on reload (`LintReport`,
   `library_writing_lib.py` line 25): hard errors E001 (forbidden builtins) and
   E003 (star imports) **block the write**; E002 (import outside the agent's
   allowed set) warns. `LibraryManager` (`library_manager.py`) cache-busts
   `sys.modules` and re-imports from disk; libraries persist across sessions.
   Attaching callables to `self` from generated code is validator-rejected;
   library modules are attached as attributes only, never injected into
   `exec_globals`. Agent-authored libraries can even ship their own
   `@slash_command` user commands.

**State, context, events** (`skills/nooa-context-and-state/SKILL.md`,
`src/nooa/runtime/context_manager.py`, `src/nooa/runtime/event_manager.py`,
`src/nooa/runtime/event_backend.py`): every agent has a `ContextManager`
(named context blocks rendered into the system prompt each turn; static or
dynamic — a Python expression re-evaluated every LLM turn) and an
`EventManager` (typed event history: `Task`, `Message`, `Error`, `Feedback`,
`PythonOutput`, `Summary`, plus runtime-only events like `LLMCallStart/End`).
Storage is behind an `EventBackend` protocol ("in-memory, SQLite, files, or
other") with active-vs-archived status. `EventQuery` scoping
(`current_call()`, `by_type()`, `last_n()`) filters what history a method's
LLM sees. Context growth is bounded by summarization agents
(`src/nooa/agents/summarization.py`: `SummarizationAgent`,
`TokenBudgetSummarizer`, `MethodSummarizer`).

**Tracing and trajectory persistence** (`src/nooa/tracing/`,
`src/nooa/atif/`): every LLM call, code execution, and method invocation is
traced by default via OpenTelemetry with parent-child spans; JSONL journal
files plus an optional live viewer (`nooa start-dev`; "if the viewer isn't
running, tracing is silently disabled"). Prompt content is journaled by
SHA-256 **block hashes** with skeleton messages so repeated blocks dedup
across steps (`tracing/_journal_builder.py`). A `SecretScrubSpanProcessor`
regex-redacts API keys/tokens/private keys from span attributes before export
(`tracing/_secret_scrubber.py`). **ATIF v1.7** (`atif/schema.py`, 388 lines;
exporter 1,405 lines) is a versioned Pydantic trajectory-interchange schema:
`StepObject` with `source` (system/user/agent), message, `tool_calls`,
`observation`, per-step `MetricsSchema` (prompt/completion/cached tokens,
`cost_usd`, optional token ids and logprobs), `llm_call_count` (0 = purely
deterministic dispatch, with validators forbidding metrics there),
`is_copied_context` ("True iff this step was retained across a compaction
boundary — SFT consumers MUST filter out"), and `SubagentTrajectoryRef` for
delegated subagent trajectories (must set at least one resolution mechanism).
Normative cross-cutting rules (sequential step ids, joinability, compaction
boundary semantics) are enforced by dedicated tests
(`tests/atif/test_normative_rules.py`).

**Long-term memory** (`packages/nooa-memory/src/nooa_memory/`): SQLite store
plus pluggable vector index (`store.py`; brute-force numpy cosine KNN by
default). `schema.py` defines a loose `Memory` record with a
Tulving/Squire-style type taxonomy (`info`, `skill`, `episode`, `intent`,
`todo`, `reflection`, `scratch`) and a typed, directed edge graph
(`derived_from`, `created_by`, `supports`, `contradicts`, `refines`, `causes`,
`precedes`, `part_of`, `triggers`). Retrieval uses ACT-R base-level activation;
forgetting is first-class on two timescales (`forgetting.py`): online
Ebbinghaus decay `R = exp(-Δt/S)` where stability scales with recall-driven
`strength`, and offline pruning (archival tombstones by default). Offline
**reflection** (`reflection.py`) runs an ordered consolidation pass —
dedup/merge → edge formation → importance re-scoring → prune — deterministic
by default, with an *optional* LLM "reasoner" enabling episode→skill
abstraction; each pass emits a `ReflectionReport` "for logs/auditability".
`MemoryManager.install(agent, ...)` wires this on additively ("zero core
edits", `manager.py`); an injected instruction tells the model "YOU own and
curate" the memory. A deliberate invariant: spontaneously **injected memories
are logged but never self-reinforce activation** (`schema.py`
`ACTR_CHANNELS` comment; "v1 invariant, manager.py touch=False semantics").

**Evaluation infrastructure** (`packages/nooa-bench/`, `util/eval_pipeline/`):
`nooa-bench` runs agents inside Harbor benchmark containers
(SWE-bench-Verified / Terminal-Bench per README), writing `result.json` and
JSONL traces into the *host-mounted* `/logs/agent` — a code comment records
that traces previously went to a container-local path and were "silently
discarded" (`runner.py`). `protocol.py` defines a swappable `ExecutionEngine`
protocol (asyncio, multiprocess, Ray, Slurm) with per-task checkpoint
`TaskState` so runs "resume from crashes or skip completed tasks";
`trace_analyzer.py` extracts per-model token/latency/cost stats from trace
files. `eval_pipeline` is a scorer-based evaluator (e.g. `ExactMatchScorer`)
over `{kwargs, expected}` datasets with multi-run self-consistency
(`util/eval_pipeline/README.md`).

**Harness self-telemetry** (`src/nooa/runtime/harness_metrics.py`): "Tracks
all places where the harness silently 'helps' the model: fence removal,
import stripping, response fixups, error recovery, etc.", flushed to the OTLP
span per generation.

**Secrets and replay** (`src/nooa/secrets.py`,
`src/nooa/unifiedllm/replay_requests.py`, `src/nooa/unifiedllm/fake.py`):
layered `secrets.yaml` → `os.environ`, non-clobbering and idempotent; the
CHANGELOG's one security note is that MCP server configs no longer expand
`${VAR}` from the host environment. Captured failed LLM HTTP requests can be
replayed for debugging (fresh key substituted for the redacted one). A
`FakeLLMClient` supports offline testing and offline prompt rendering
(`skills/refine-agent-prompt/SKILL.md`).

**Scale/quality signals:** 384 test files under `tests/`; ruff + pyright +
pre-commit; an `AGENTS.md` of repo conventions written for coding agents.

## Analysis dimensions

**Runtime, task, environment, and state models.** Runtime: an async Python
process; each generation-method call is an LLM-driven loop (strategy) over the
agent's event history and context blocks. Task = a typed method call; there is
no first-class "task suite" object in core (benchmarks supply tasks
externally via `nooa-bench`/`eval_pipeline`). Environment = the agent object
itself plus a Python REPL namespace (CodeAct) and optional shell/MCP skills.
State = typed fields on the object, context blocks, and the event history —
all per-instance, in-process by default.

**Observation, trajectories, traces, memory, persistence.** Very strong.
Three layers: (1) the event history that *is* the LLM's context, behind a
pluggable `EventBackend`; (2) OTel spans → JSONL journals with hash-dedup'd
prompt blocks and secret scrubbing; (3) ATIF v1.7 — a versioned, validated,
interchange-grade trajectory schema with per-step cost metrics, compaction
markers, and subagent references, explicitly designed so downstream "SFT
pipelines" can consume trajectories. Durable memory is a separate opt-in
subsystem (SQLite + vectors + typed graph + decay).

**Trusted/immutable vs evolvable surfaces.** Present in practice, never named
as a design object. Trusted: all framework code, strategies, validators,
sandbox, prompts assembled by the runtime. Evolvable-by-the-agent: REPL
namespace (ephemeral), context blocks and event history (session-scoped),
memory contents (durable, agent-curated), and agent-authored libraries under
`libs/` (durable code). The boundary is enforced mechanically in one
direction — generated code cannot attach callables to `self`, mutate classes,
or touch dunders (validator E10x/E4xx), and library modules are attached as
attributes, never injected into `exec_globals` — but there is **no
accept/reject regime** governing changes to the evolvable surfaces.

**Recursive decomposition, subagents, context management.** Standalone
`@strategy` functions run per-item sub-calls on fresh agent stubs (fan-out via
`asyncio.gather`); `ScopedContext`/`EventQuery.current_call()` give sub-calls
clean context; ATIF models subagent trajectories as first-class references;
summarizers bound long histories with an explicit compaction-boundary marker.
Decomposition is programmer- or model-directed, not automatic.

**Candidate generation and self-modification.** The agent generates code
constantly (CodeAct cells) and can durably extend itself (libraries). The
gates on durable self-modification are **static lint (hard errors block the
write) plus optional self-run pytest** — the skill doc even warns "Enforce
'run `run_tests()` before claiming done' in the orchestrator, not just the
prompt". There is no notion of candidate-vs-incumbent, no A/B evaluation, no
journaled accept/reject decision.

**Evaluation, selection, promotion, rollback, lineage.** Evaluation exists
but is *offline harness evaluation for humans* (benchmarks, scorers,
self-consistency runs), not wired into any promotion decision. Selection and
promotion: not addressed by source. Rollback: not addressed by source
(libraries are plain files a human could git-revert; checkpointing in
`nooa-bench` is crash-resume, not rollback). Lineage: partial — the memory
graph has causal `derived_from`/`created_by` edges and reflection emits audit
reports; trajectories carry full provenance; but agent-authored *code* has no
lineage record at all.

**Sandboxing, secrets, permissions, budgets, recovery.** The strongest part
of the repo. Two-layer story stated identically in README, validator, and
restrictions module: static AST validation = guardrails/feedback; OS isolation
= the real boundary (unprivileged Landlock + seccomp + rlimits installed by
the child on itself, fail-closed capability probing, parent hard-kill,
worker restart, brokered `self.*` calls so agent state never enters the
sandboxed process). Budgets: `cell_timeout`, `max_memory_mb`,
`max_cpu_seconds`, `max_iterations`, token-budget summarization; per-step USD
cost in traces. Secrets: env-var indirection, scrubbing before export,
non-expansion of `${VAR}` in MCP configs. Recovery: validation-retry with
formatted feedback, worker restarts, checkpointed benchmark runs, replayable
failed LLM requests.

**Online adaptation vs offline optimization.** Online: within-call Reflexion
retries; across-session memory accrual and library accumulation. Offline:
memory *consolidation* (reflection pass after tasks) and benchmark evaluation.
Offline *optimization* of prompts/strategies/configs against a metric (GEPA-,
AlphaEvolve-style): not addressed by source — `refine-agent-prompt` is a
human-driven diagnostic workflow.

**Harness adaptation vs model-weight learning.** The harness never trains
weights. But ATIF is explicitly built so trajectories become SFT data for
*external* training pipelines ("downstream consumers (validators, dashboards,
SFT pipelines)", `atif/schema.py`) — the repo positions the harness as a
trajectory *producer* for weight learning done elsewhere.

**Genuinely self-improving vs merely persistent/configurable.** By strive's
charter definition, NOOA is **persistent and self-extending, not
self-improving**: changes to durable surfaces are produced by the agent and
retained, but they are not motivated by recorded evidence of the agent's own
failures, not validated empirically against an incumbent, and not journaled
as reversible decisions. The closest approach to genuine self-improvement is
the memory subsystem: evidence-driven (episodes), autonomous consolidation
with audit reports, decay-based pruning, and a reward-hygiene invariant
(injection never self-reinforces). Reflexion is self-*correction* within a
call, discarded afterward.

**Mechanisms suitable for a robust, long-lived harness.** Verified in source:
fail-closed sandbox capability probing; irrevocable self-imposed kernel
limits; error-code registries with fix hints turning failures into structured
LLM feedback; harness-help telemetry (every silent fixup measured); versioned
trajectory schema with normative rules enforced by tests; hash-dedup'd prompt
journaling; secret scrubbing at the export boundary; deterministic fake LLM
client keeping the test suite offline; additive subsystem installation
(memory installs with "zero core edits"); traces written to host-mounted
paths so container teardown can't destroy evidence.

## Interpretations

(Inferences, not verified claims.)

- NOOA and strive are complements, not competitors: NOOA is a mature
  *execution* harness (act, observe, contain, record) with no evolution loop;
  strive is an evolution loop with a thin execution harness. Nearly every gap
  in strive's HANDOFF (sandbox threat model, journaling model I/O, replay) has
  a worked implementation here, and nearly everything strive has
  (accept/reject, ledger, lineage, rollback) is absent here.
- The three-tier self-extension ladder (ephemeral cell → scoped sub-call →
  persistent library) looks like a deliberate blast-radius gradient: the more
  durable the artifact, the more gates (lint, tests, explicit reload). But the
  top gate is self-attestation — the agent runs its own tests — which is
  exactly the overfitting/reward-hacking shape strive's charter worries about.
- The repeated, almost verbatim "guardrails, not a security boundary" text in
  three places reads like a lesson learned: teams *will* mistake AST
  deny-lists for a jail unless the code itself keeps saying otherwise.
- `is_copied_context` existing at schema level implies they got burned by
  training/analysis pipelines double-counting compacted context — a subtle
  trace-integrity failure strive hasn't hit yet but will once summarization
  enters the loop.
- The memory invariant "injected memories never self-reinforce" is a
  feedback-loop-hygiene rule: without it, whatever the retriever surfaces
  becomes more retrievable, a self-amplifying bias — structurally the same
  failure as validating a candidate on the cases that motivated it.

## Hypotheses to test in strive

1. **Lint-plus-self-tests is an insufficient acceptance gate.** Give a
   (fake-)model proposer a library-style surface gated only by NOOA's E001/E003
   lint + self-authored tests; measure how often accepted changes regress a
   held-out suite versus strive's incumbent-comparison gate.
2. **Structured error feedback beats raw tracebacks for repair proposals.**
   NOOA formats every validation failure into coded, actionable feedback.
   Test: proposer repair success rate given strive's raw `CaseResult` errors
   vs. a diagnoser that emits coded findings with fix hints.
3. **Harness-help telemetry improves credit assignment.** Instrument strive's
   runner/evaluator to record every silent normalization (output coercion,
   whitespace stripping). Hypothesis: some "improvements" attributed to
   candidates are actually harness fixups; the metric detects them.
4. **Self-imposed rlimits + no-network are enough for stage-3 candidates.**
   Port the `guards.py` pattern (child installs RLIMIT_AS/RLIMIT_CPU;
   fail-closed probe) into `strategy_runner.py`; verify the planted-weakness
   suite still passes and that a hostile candidate (fork bomb, socket open,
   memory balloon) is contained on Linux and *rejected as unenforceable*
   elsewhere.
5. **Compaction markers preserve replayability.** When strive later summarizes
   evidence for the proposer, an `is_copied_context`-style flag on journaled
   events should be sufficient to reconstruct exact proposer inputs; test by
   replaying a cycle from the ledger after summarization.

## Mechanisms: early prototype vs mature harness

**Adopt now (cheap, matches strive's current stage):**

- The two-sentence security doctrine, written into `sandbox.py`'s docstring:
  static checks are feedback/guardrails; the process boundary is containment;
  never extend deny-lists to "close an escape".
- Error-code registry for diagnoser signatures and validation failures
  (NOOA's E-code table is the model): machine-readable, testable, and the
  natural key for strive's signature registry as it grows.
- Fail-closed capability probing: before running a candidate, probe which
  isolation guarantees the host can actually enforce; refuse (and journal the
  refusal) rather than degrade silently.
- Deterministic fake model client as a first-class citizen of the adapter
  interface (HANDOFF item 2) — NOOA ships `FakeLLMClient` in the core LLM
  package, not in tests.
- Host-durable artifact paths: whatever executes in isolation must write its
  evidence to storage that outlives the execution environment (the
  `/logs/agent` lesson).

**Adopt at stage 3–4 (real sandboxing, real benchmarks):**

- The `guards.py` mechanism itself: unprivileged Landlock + seccomp + rlimit
  self-restriction after fork — a concrete, dependency-free middle rung
  between `python -I` and containers for strive's stage-3 isolation decision
  (HANDOFF item 5), including brokering any trusted-side calls rather than
  importing trusted state into the sandbox.
- Harness-metrics ("silent help") telemetry attached to every cycle's event
  stream, feeding credit assignment.
- Checkpointed evaluation runs (`TaskState`-style resume) once suites are big
  enough that a crash mid-validation is expensive.
- Hash-dedup'd journaling of proposer prompts (block skeleton + SHA-256) once
  model I/O journaling (HANDOFF item 4) makes ledgers large.

**Adopt at stage 5+ (durable memory, online adaptation):**

- The memory design wholesale as a reference: typed record taxonomy, causal
  edge graph (`derived_from` = lineage for memory), decay-based forgetting,
  offline consolidation passes that emit audit reports, and the
  no-self-reinforcement invariant for anything the system injects into its own
  context.
- ATIF-style versioned trajectory schema with normative-rule tests and
  subagent references, replacing ad-hoc event dicts (the HANDOFF already flags
  the shared-codec debt; a versioned schema with structural validators is the
  end state).

## Implications for strive

- **`sandbox.py` interface should be capability-based now.** Add a
  `probe() -> Capabilities` / `check_enforceable(config) -> list[str]` step to
  the runner boundary, even while the only mechanism is subprocess+timeout.
  The stage-3 upgrade (rlimits, Landlock, seccomp) then slots in without an
  interface change, and "ran with degraded isolation" can never happen
  silently — it's a journaled refusal.
- **Diagnoser output should be coded findings, not strings.** Signature ids
  become stable error codes with optional fix hints; the proposer contract
  takes `list[Finding]`. This is also what makes proposer-repair loops
  (feeding validation failures back to a model proposer) tractable.
- **Acceptance rules must stay incumbent-relative.** NOOA demonstrates the
  alternative — self-attested tests as the only gate — and its own docs
  distrust it ("enforce … in the orchestrator, not just the prompt"). Strive's
  differentiator is exactly the journaled candidate-vs-incumbent decision;
  don't weaken it when strategies become library-like multi-file artifacts.
- **Add harness-intervention events to the trusted evaluator.** Any place
  `evaluate.py`/`strategy_runner.py` normalizes candidate output must emit an
  event; otherwise credit assignment (charter research question 5) is
  corrupted by invisible help.
- **Plan the ledger toward a versioned schema.** Adopt NOOA's pattern:
  Pydantic models = canonical representation, structural validation at parse
  time, normative cross-record rules (monotonic ids, activation refers to
  existing generation, derived-pointer consistency) enforced by a dedicated
  test module. Include a compaction/`is_copied_context` marker the day any
  summarization touches journaled evidence.
- **Model adapter: journal + scrub + replay as one unit.** NOOA couples LLM
  I/O capture with secret scrubbing at the export boundary and a replay tool
  for failures. Strive's `ModelAdapter` (HANDOFF item 2/4) should specify all
  three in the protocol from the start: journaled request/response, redaction
  before persistence, and offline replay from the ledger.
- **Memory as a future evolvable surface has a ready-made safety rule:**
  whatever the loop injects into its own context must not increase its own
  retrieval probability. Record it now as a charter-level invariant for stage
  5, alongside "the evaluator may never be evolved against itself".
