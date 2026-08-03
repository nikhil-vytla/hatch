# Parallax rebuilt around the real Evolving Intent algorithm — candidate A

Design package for replacing the Parallax shortcut implementation with a faithful
port of `microsoft/evolving-intent` @ `993d6be9597ac03854b46362ccd647eb1bfd267a`,
while keeping Parallax's deterministic artifact identity, sealing, admission, and
locked replay below a hard freeze boundary.

Grounding sources: upstream `intent_construction/` (extraction, counterfactual,
predecessor), `situated_simulation/` (`user_intent.py`, `turn_scheduler.py`,
`turn_scheduler_swe.py`, `user_simulation.py`, prefix pools), `evaluation/`
(per-domain native evaluators); Parallax `src/parallax/{evolving_intent,kernel,
gsm8k,swebench,variants,autoresearch}.py`; the correction predicate in
`architecture/evolving-intent-pipeline/NOTES.md`; the audit consensus.

---

## 1. Problem

Parallax today proves determinism plumbing (compile, seal, admit, replay, grade)
over a hand-authored `ProposalBundle` fixture. It implements none of the upstream
algorithm: no provider-backed function/argument extraction, no argument
counterfactual generation, no chained predecessor generation, no plan-first
scheduler, no domain rendering. Its terminal turn repeats the full source
question, which deletes the paper's central pressure (reconstructing active
intent from history). Replay validates a magic goal string
(`answer_source_task`) instead of replaying source-argument state. The kernel is
GSM8K-hardcoded; SWE-bench lives in a disconnected parallel module; four intent
models coexist (`evolving_intent.Reveal/Revise/Switch`, `variants.IntentEvent`,
`autoresearch.IntentCondition`, `swebench.SweBenchIntentArm`); fixtures carry
fabricated digests; tests prove self-consistency against those fixtures.

Constraints the design must honor:

- **The upstream algorithm is a 5-stage pipeline with a natural freeze line.**
  Stages 1–3 (extract, counterfactual, predecessor) are stochastic and
  provider-backed. Stages 4–5 (schedule/render, run/evaluate) are deterministic
  given the stage-3 record plus scenario knobs `(g, p, t, seed)` — upstream's
  `create_sample` is a pure function in eval mode. Parallax's sealing/admission
  machinery belongs *below* that line, not above it.
- **The verification predicate**: generation must run through a provider
  abstraction; raw and parsed intermediates must be preserved; turns must be
  scheduled from typed intent state; the terminal turn must not restate the
  complete source task when the scenario requires history reconstruction;
  grading must use the source benchmark's native evaluator.
- **Fixture compatibility**: upstream's Stage-3 JSON
  (`function`/`arguments`/`counterfactual_arguments`/`predecessor_functions`)
  is the interchange format the paper's own eval indices reference. We must be
  able to ingest an upstream-produced record and schedule it identically —
  that is the falsifiable parity lever.
- **Exact output parity is not required** (generations are stochastic), but
  *algorithmic* parity is: same stage semantics, same validation gates, same
  scheduler invariants, same native evaluators.

---

## 2. Caller usage (written first; the spec)

### 2.1 CLI quickstart

```bash
# Stage 1–3: provider-backed generation from a pinned benchmark record.
# Emits a content-addressed ExpandedRecord + evidence ledger + expanded.lock.
parallax generate \
    --domain gsm8k --record-id test/17 \
    --model gpt-5.1 --judge-model gpt-5.1 --fallback-model gpt-5.1-pro \
    --num-counterfactuals 4 --num-predecessors 3 \
    --store ./artifacts

# Stage 4: deterministic build. Compiles conversation arms (scenarios) from the
# frozen record, runs admission, seals, writes family.lock. No network.
parallax build experiment.toml --store ./artifacts

# Byte-identical locked replay (no network, no provider):
parallax build --locked family.lock --store ./artifacts

# Stage 5: drive an agent through one arm; grade with the native evaluator.
parallax run --family <family_id> --arm combined --agent openai:gpt-5.1 \
    --store ./artifacts
```

`experiment.toml` names the frozen inputs and scenario knobs — nothing else:

```toml
[record]                     # frozen Stage-3 artifact (ours or upstream's JSON)
path = "records/gsm8k-test-17.expanded.json"
sha256 = "…"

[scenarios]                  # the arms of the family, upstream vocabulary
fully_specified = { num_turns = 1 }
argument_reveal = { num_turns = 6 }
combined        = { num_turns = 6, num_revisions = 2, num_switches = 2 }

[build]
seed = 42
output_tokens_per_turn = 512
```

### 2.2 Python call sites

```python
# --- call site 1: generation (research script) -------------------------------
import parallax
from parallax.provider import OpenAiProvider

provider = OpenAiProvider.from_env()          # or DeterministicFakeProvider in tests
record = parallax.generate(
    domain="gsm8k",
    record_id="test/17",
    provider=provider,
    policy=parallax.GenerationPolicy(
        model="gpt-5.1", judge_model="gpt-5.1", fallback_model="gpt-5.1-pro",
        num_counterfactuals=4, num_predecessors=3, max_attempts=5,
    ),
)                                              # -> ExpandedRecord (frozen)
record.write(store / "records")                # content-addressed + evidence

# --- call site 2: build + run (evaluation script) ----------------------------
family = parallax.build(experiment=Path("experiment.toml"), store=store)
arm = family.arm("combined")                   # RenderedConversation
print(arm.messages()[0].content)               # derived from typed intent state

async def agent(messages): ...                 # (ConversationMessage, ...) -> str
verdict = await parallax.run(arm, agent=agent, evaluator=parallax.evaluator_for(arm))
assert verdict.evaluator_id == "gsm8k.native.v1"

# --- call site 3: ingest an upstream fixture and check scheduling parity -----
record = parallax.ExpandedRecord.from_upstream_json(
    Path("upstream/final_dataset/gsm8k_final.json"), index=0,
    upstream_revision="993d6be9597ac03854b46362ccd647eb1bfd267a",
)
plan = parallax.schedule(record, parallax.ScenarioSpec(num_turns=4, num_revisions=2), seed=42)
```

### 2.3 Custom non-paper domain (HumanEval)

Adding a domain touches exactly one package (`parallax/domains/`) and zero lines
of kernel/scheduler code:

```python
# parallax/domains/humaneval.py
from parallax.domain import Domain, DomainProfile, register_domain
from parallax.record import SourceRecord
from parallax.evaluate import NativeEvaluator, EvalVerdict

class HumanEvalEvaluator(NativeEvaluator):
    evaluator_id = "humaneval.exec.v1"
    def identity(self) -> dict[str, str]:
        return {"harness": "humaneval-exec", "python": "3.12", "sandbox_image_sha256": "…"}
    def grade(self, record: SourceRecord, final_response: str) -> EvalVerdict:
        raise NotImplementedError  # extract ```python block, run hidden tests in sandbox

class HumanEvalDomain(Domain):
    name = "humaneval"
    profile = DomainProfile(
        prompt_pack="prompts/humaneval",       # segmentation/conversational/verification/
                                               # counterfactual/predecessor templates
        predecessor_archetypes=("compute_then_extend", "reframe_problem"),
        prefix_pools="dev",                    # reuse SWE developer-tone pools
        answer_format="python_block",
    )
    def load_record(self, record_id: str) -> SourceRecord:
        raise NotImplementedError              # pinned HF revision -> SourceRecord
    def evaluator(self) -> NativeEvaluator:
        return HumanEvalEvaluator()

register_domain(HumanEvalDomain())
```

```bash
parallax generate --domain humaneval --record-id 42 --model gpt-5.1 --store ./artifacts
```

---

## 3. Core data shapes

One intent model. It is upstream's formalization (`I_t = (f_t, C_t, C_rev_t,
y_t)`), typed so invalid states don't construct. Everything below is frozen
dataclasses; mutation happens only inside the scheduler's private slot-building
step, which returns frozen plans.

```python
# ── parallax/record.py ── knowledge: what a benchmark record IS ──────────────

@dataclass(frozen=True)
class SourceRecord:
    """A pinned benchmark record. Identity-bearing; never re-fetched at build time."""
    domain: str                       # "gsm8k" | "bird_sql" | "browsecomp_plus" | "swe_bench_verified" | custom
    dataset: str                      # e.g. "gsm8k"
    dataset_revision: str             # pinned HF revision / corpus hash
    record_id: str                    # upstream original_id (eval_indices compatible)
    question: str                     # full original task text
    answer: str                       # native gold ("" for SWE; tests are authority)
    native: Mapping[str, CanonicalValue]  # domain payload: schema+db_path (SQL),
                                          # repo/base_commit/test_patch/F2P/P2P (SWE),
                                          # evidence_docs (browsecomp). Parsed, validated
                                          # by the domain at load; opaque to the kernel.
    @property
    def digest(self) -> str: ...      # digest_value(canonical payload)

@dataclass(frozen=True)
class Counterfactual:
    """A validated single-value swap of one argument (upstream Stage 2 output)."""
    text: str                         # counterfactual_argument
    original_value: str               # must occur in the source argument text
    counterfactual_value: str         # must occur in `text`
    # INVARIANT (checked in __post_init__, same rules as upstream
    # CounterfactualGenerator.validate_counterfactual): forward reconstruction —
    # source.replace(original_value, counterfactual_value, 1) == text (modulo
    # a/an + apostrophe normalization); no containment; length-ratio bound.

@dataclass(frozen=True)
class Argument:
    """c_i: one argument with its counterfactual variants."""
    argument_id: int
    text: str                         # source (true) value
    counterfactuals: tuple[Counterfactual, ...] = ()

@dataclass(frozen=True)
class PredecessorArgument:
    argument_id: int                  # shared ids reference the source set; new ids are
    text: str                         # fabricated (upstream convention: max_id+100+i)
    is_shared: bool

@dataclass(frozen=True)
class Predecessor:
    """One G_{t-k} in the chained predecessor sequence (upstream Stage 3 output)."""
    function: str
    arguments: tuple[PredecessorArgument, ...]
    taxonomy: Taxonomy                # StrEnum: T1_KNOWLEDGE | T2_DECOMPOSITION |
                                      #          T3_SEQUENTIAL | T4_PIVOT
    archetype: str                    # e.g. "compute_then_extend"
    transition_reason: str
    transition_phrase: str | None = None   # SWE impl-precursor verbatim phrase
    entity_sought: str = ""

@dataclass(frozen=True)
class StageEvidence:
    """Raw provenance for ONE provider call. Sealed; grouped per stage."""
    stage: Stage                      # StrEnum: EXTRACT | COUNTERFACTUAL | PREDECESSOR | VERIFY
    step: str                         # e.g. "decompose", "coverage", "independence-run-2"
    model: str
    parameters: tuple[tuple[str, CanonicalValue], ...]   # temperature, reasoning_effort, …
    prompt_digest: str                # sha256 of canonical request
    raw_response: str                 # the actual bytes back — kept, not just digested
    parsed_digest: str                # sha256 of the parsed structure derived from it
    attempt: int
    outcome: CallOutcome              # StrEnum: ACCEPTED | REJECTED_VALIDATION |
                                      #          REJECTED_JUDGE | ERROR

@dataclass(frozen=True)
class ExpandedRecord:
    """The freeze boundary. Everything stochastic is behind this; everything
    after is a deterministic function of (ExpandedRecord, ScenarioSpec, seed)."""
    format: str = "parallax.expanded-record.v2"
    source: SourceRecord
    function: str                     # f_T — extracted main question
    arguments: tuple[Argument, ...]   # C_T with counterfactual variants
    predecessors: tuple[Predecessor, ...]   # stored NEAREST-first (upstream order;
                                            # scheduler reverses to farthest-first)
    generation: GenerationStamp       # upstream_revision, policy, seed, timestamps
    evidence: tuple[StageEvidence, ...]     # full raw ledger, sealed
    verification: VerificationSummary      # coverage/solvability/cross-turn/independence
                                            # verdicts with evidence indices
    @property
    def digest(self) -> str: ...            # commits to source + parsed + evidence digests
    @classmethod
    def load(cls, path: Path) -> ExpandedRecord: ...
    @classmethod
    def from_upstream_json(cls, path: Path, *, index: int, upstream_revision: str) -> ExpandedRecord:
        """Parse upstream final_dataset schema into typed form. Provenance is marked
        GenerationStamp(kind='upstream-import'); no fabricated digests — evidence
        is empty and the record is admissible only for scheduling-parity tests,
        never for shipping families (admission enforces this)."""
```

```python
# ── parallax/intent.py ── knowledge: the paper's intent formalization ────────

@dataclass(frozen=True)
class IntentState:
    """I_t = (f_t, C_t, C_rev_t, y_t). One snapshot per user turn."""
    function: str
    revealed_ids: frozenset[int]
    active_values: tuple[tuple[int, str], ...]   # only entries differing from source
    target_answer: str                            # "" when undefined mid-conversation

@dataclass(frozen=True)
class Reveal:
    argument_ids: tuple[int, ...]

@dataclass(frozen=True)
class Revision:
    argument_id: int
    old_text: str
    new_text: str                     # intermediate counterfactual or source value

@dataclass(frozen=True)
class FunctionSwitch:
    old_function: str
    new_function: str
    taxonomy: Taxonomy | None         # None only for restoration to source

Transition: TypeAlias = Reveal | Revision | FunctionSwitch

@dataclass(frozen=True)
class TurnPlan:
    """Typed content of one user turn. The renderer derives text from THIS;
    text never appears here."""
    index: int
    switch: FunctionSwitch | None     # at most one; always first in the turn
    revisions: tuple[Revision, ...]   # after switch, before reveals
    reveals: tuple[Reveal, ...]       # ordered; SWE symptom items front-loaded
    state_after: IntentState          # I_t — derived, single source of truth

@dataclass(frozen=True)
class ConversationPlan:
    """Deterministic output of the scheduler. Frozen and replayable."""
    scenario: Scenario                # StrEnum: FULLY_SPECIFIED | ARGUMENT_REVEAL |
                                      #   ARGUMENT_REVISION | FUNCTION_SWITCH | COMBINED
    spec: ScenarioSpec                # requested (t, p, g); actuals recorded separately
    turns: tuple[TurnPlan, ...]
    final_label: str
    per_turn_gold: tuple[TurnGold, ...] | None   # SQL only

@dataclass(frozen=True)
class ScenarioSpec:
    num_turns: int = 1
    num_revisions: int = 0
    num_switches: int = 0
    recap: RecapMethod | None = None  # PROMPT | DUMP | GROUND_TRUTH
    def scenario(self) -> Scenario: ...   # upstream inference rule
```

**Invariants encoded in types, not runtime checks:**

- A `Counterfactual` that isn't a clean value swap cannot be constructed
  (validation in `__post_init__` mirrors upstream's programmatic checks).
- A `TurnPlan` cannot hold free-text; messages must be derived, so a
  full-question terminal dump has no representation.
- `replay(plan)` (below) recomputes each `state_after` from transitions and the
  record; a plan whose stored states disagree with replay fails structurally —
  no magic goal strings.
- `ExpandedRecord` requires either a non-empty evidence ledger or an explicit
  `upstream-import` stamp; "fabricated provenance" is unrepresentable.

---

## 4. Module map and function signatures

```
src/parallax/
├── __init__.py          # public API: generate, build, run, schedule, render,
│                        #   ExpandedRecord, ScenarioSpec, Family, Verdict
├── ids.py               # KEEP AS IS: canonical_bytes, digest_value, task_id_for
├── record.py            # SourceRecord, Argument, Counterfactual, Predecessor,
│                        #   ExpandedRecord, StageEvidence, upstream JSON parsing
├── intent.py            # IntentState, Transition, TurnPlan, ConversationPlan,
│                        #   ScenarioSpec, replay()
├── provider.py          # Provider protocol, OpenAiProvider, DeterministicFakeProvider,
│                        #   RecordingProvider (evidence capture), retry/backoff
├── construction/        # the stochastic plane (upstream Stages 1–3)
│   ├── extract.py       #   Stage 1 engine
│   ├── counterfactual.py#   Stage 2 engine
│   ├── predecessor.py   #   Stage 3 engine (chains, judges, independence)
│   └── pipeline.py      #   generate(): orchestration, evidence assembly, freezing
├── schedule.py          # Stage 4a: plan-first scheduler (pure; upstream steps 0–3)
├── render.py            # Stage 4b: renderer — TurnPlan -> ConversationMessage,
│                        #   prefix pools, join rules, recap computation
├── family.py            # arms, admission, sealing, content-addressed store,
│                        #   family.lock, locked rebuild  (kernel.py successor)
├── run.py               # conversation runtime: drive agent, collect transcript
├── evaluate.py          # NativeEvaluator protocol, EvalVerdict, evaluator_for()
├── domain.py            # Domain protocol, DomainProfile, registry
└── domains/
    ├── gsm8k.py         # loader, prompts, math evaluator (keeps current parser)
    ├── bird_sql.py      # loader, sql_partial per-turn gold, execution evaluator
    ├── browsecomp.py    # loader, BM25 independence support, LLM-judge evaluator
    └── swebench.py      # loader, impl-precursor pairing, symptom post-fill hook,
                         #   docker-harness evaluator
```

Signatures (bodies `not implemented`; pseudocode where the logic is subtle):

```python
# ── parallax/provider.py ─────────────────────────────────────────────────────

class Provider(Protocol):
    def complete(self, request: LlmRequest) -> LlmResponse: ...
    # LlmRequest: messages, model, temperature, max_tokens, reasoning_effort,
    #             response_format ("text" | "json"). Canonically digestible.
    # LlmResponse: raw_text (exact bytes), model, usage. Nothing pre-parsed.

class RecordingProvider:
    """Wraps any Provider; appends one StageEvidence per call to a ledger.
    ALL construction-plane calls go through this — it is impossible to reach
    the network without leaving evidence."""
    def __init__(self, inner: Provider, ledger: EvidenceLedger, stage: Stage): ...
    def complete(self, request: LlmRequest, *, step: str, attempt: int) -> LlmResponse: ...

class DeterministicFakeProvider:
    """Test double: responses keyed by (step, prompt_digest) from a fixture dir;
    raises MissingFixture with the digest so tests fail loudly, never silently."""

# ── parallax/construction/extract.py ── Stage 1 ─────────────────────────────

def extract_intent(
    source: SourceRecord, domain: Domain, provider: RecordingProvider,
    policy: GenerationPolicy,
) -> tuple[str, tuple[Argument, ...]]:
    """Upstream BaseExtractor.extract(), faithfully:
    for attempt in 1..policy.max_attempts:
        decomposed   = domain.decompose(source, provider)          # LLM, json
        conversational = domain.to_conversational(source, decomposed, provider)
        extracted    = _as_function_and_arguments(conversational)
        if not domain.verify_coverage(source, extracted, provider): continue   # judge
        best = extracted
        if policy.verify_solvability and not domain.verify_solvability(...): continue
        return best
    # 2nd pass: LLM-as-judge on best coverage-passing attempt
    # 3rd pass: solvability on coverage-FAILED attempts (upstream fallback)
    raise ExtractionFailed(record_id, evidence_span)
    """

# ── parallax/construction/counterfactual.py ── Stage 2 ──────────────────────

def generate_counterfactuals(
    function: str, arguments: tuple[Argument, ...], domain: Domain,
    provider: RecordingProvider, policy: GenerationPolicy,
) -> tuple[Argument, ...]:
    """Per argument, per variant slot (num_counterfactuals, round targets):
    - prompt = domain counterfactual template + previously-accepted variants
      ("generate a DIFFERENT counterfactual") + validation feedback from the
      last rejected attempt (upstream's feedback loop).
    - Constructing Counterfactual(...) IS the validation (forward
      reconstruction / containment / length); rejection reason feeds the retry.
    - Duplicate texts retried up to 2 extra times, then the slot is skipped.
    Zero accepted counterfactuals across all arguments -> StageFailed."""

# ── parallax/construction/predecessor.py ── Stage 3 ─────────────────────────

def generate_predecessor_chain(
    function: str, arguments: tuple[Argument, ...], answer: str,
    domain: Domain, provider: RecordingProvider, policy: GenerationPolicy,
) -> tuple[Predecessor, ...]:
    """Chained generation, upstream semantics preserved exactly:
    - iterate k = 1..num_predecessors: generate G_{t-k} FROM G_{t-k+1}
      (its function + full argument set), never from G_t directly;
    - per step: archetype sampled from domain.profile.predecessor_archetypes
      (seeded RNG); prompt includes avoid-list, share-range/share-num
      instruction, and the full FUTURE chain context;
    - per-candidate gates, in order: non-empty; exact-duplicate; LLM-judge
      similarity vs every prior function; dangling-reference regex; entity-type
      dedup; <=35 words; answer-keyword-leakage (>=2 distinctive keywords);
    - MODEL ESCALATION: at attempt >= max_attempts//2 switch to
      policy.fallback_model (upstream behavior), recorded per-call in evidence;
    - chain-level: cross-turn relevance judge over every turn's fabricated
      arguments vs every other turn AND vs the final function; regenerate the
      whole chain up to max_verify_attempts;
    - functional independence g(C ∪ C_new) == g(C): majority vote over
      policy.independence_runs solves with/without fabricated arguments, pass
      if answers match or extended answer is correct, judged by
      domain.evaluator() (math) or domain-specific compare (BrowseComp BM25-RAG
      with retrieval frozen to the base query); on failure, feedback-based
      regeneration of fabricated arguments up to max_independence_retries;
    - every verdict lands in VerificationSummary with evidence indices."""

# ── parallax/construction/pipeline.py ───────────────────────────────────────

def generate(
    *, domain: str, record_id: str, provider: Provider, policy: GenerationPolicy,
) -> ExpandedRecord:
    """Load pinned record -> extract -> counterfactuals -> predecessors ->
    assemble ExpandedRecord with the complete evidence ledger -> freeze.
    Idempotence: writing to a store is content-addressed; re-running generation
    produces a NEW record (new evidence) rather than mutating an old one."""

# ── parallax/schedule.py ── Stage 4a (pure functions; no I/O, no provider) ──

def schedule(
    record: ExpandedRecord, spec: ScenarioSpec, *, seed: int,
) -> ConversationPlan:
    """Upstream create_sample steps 0–3 (rendering excluded), eval-mode
    determinism. Preserved invariants (each is an admission check too):
      0. SELECT: predecessors reversed to farthest-first; counterfactuals
         round-robin across eligible arguments, shared-first pool ordering.
      1. SCHEDULE EVENTS: deadline map (a revision chain completes before the
         first function needing its source value; non-shared -> post-source
         bucket); even spread; final switch (restoration to source function)
         pinned to the last turn unless post-source corrections exist.
      2. FILL ARGUMENTS: turn-0 keeps >=1 argument; deferral before deadlines;
         empty-slot stealing with the redundancy guard; trim + renumber;
         stale-text fix for redistributed counterfactual items.
      2d. domain.post_fill_hook(slots, record)  # SWE symptom front-loading
      3. FILL TEXTS: correction chain [v2..vN, source]; restoration switch
         carries the SOURCE FUNCTION text only — never the full question.
    min_turns = 1 + g + p; returns PlanInfeasible (typed error) when the record
    lacks the requested switches/revisions or t < min_turns.
    Every TurnPlan.state_after is computed here and re-derivable by replay()."""

def replay(record: ExpandedRecord, plan: ConversationPlan) -> tuple[IntentState, ...]:
    """Fold transitions from I_0. Raises PlanTamperedError unless:
      - each recomputed state equals plan.turns[i].state_after,
      - the final state has function == record.function, every active value ==
        its source text, revealed_ids covers all argument_ids relevant to the
        final function, and target_answer == plan.final_label,
      - revisions match declared old/new against the counterfactual chains.
    This REPLACES the magic-goal check: correctness is restoration of source
    ARGUMENT STATE, not equality with a sentinel string."""

# ── parallax/render.py ── Stage 4b (deterministic text derivation) ──────────

def render(
    plan: ConversationPlan, record: ExpandedRecord, domain: Domain, *, seed: int,
) -> tuple[ConversationMessage, ...]:
    """TurnPlan -> user message text. Owns: prefix pool selection (eval-mode
    deterministic cycling per pool, per upstream), taxonomy/transition-phrase
    routing for switch prefixes, within-turn order switch->revision->reveal,
    join_prefix_content casing rules, first-letter capitalization, SQL
    schema+evidence prepend on turn 1, domain system prompt, instruction
    wrapping, recap text (PROMPT | DUMP | GROUND_TRUTH from typed state).
    Pure: same inputs -> same bytes. Renderer version is identity-bearing."""

# ── parallax/family.py ── freeze-boundary kernel (deterministic plane) ──────

@dataclass(frozen=True)
class RenderedConversation:
    record_digest: str
    plan: ConversationPlan
    messages_public: tuple[ConversationMessage, ...]   # system + opening turn only
    messages_sealed: tuple[ConversationMessage, ...]   # scheduled future turns
    def task_id(self) -> str: ...    # task_id_for(public_digest, sealed_digest)

@dataclass(frozen=True)
class Family:
    family_id: str
    record_digest: str
    evaluator_identity: tuple[tuple[str, str], ...]    # committed at build time
    arms: tuple[RenderedConversation, ...]             # one per scenario in the experiment
    certificate: AdmissionCertificate
    def arm(self, scenario: str) -> RenderedConversation: ...

def build(*, experiment: Path | None, locked: Path | None, store: Path) -> Family:
    """Same lock/store discipline as today's kernel.build_experiment (atomic
    publish, byte-identical locked rebuild, digest-pinned references), but:
    - record reference is an ExpandedRecord (any domain), not a GSM8K fixture;
    - admission policy v2 (below);
    - family_id commits to record.digest + scenario specs + seed + scheduler
      version + renderer version + prefix-pool version + evaluator identity."""

# Admission policy "evolving-intent-admission.v2" — every check yields evidence:
#   replay_integrity          replay() passes for every arm
#   scenario_parity           arms share record digest + evaluator identity + budget rules
#   terminal_reconstruction   for scenarios with num_turns > 1: the final turn's
#                             rendered text does NOT contain the full source
#                             question, and at least one argument revealed in an
#                             earlier turn is absent from the final turn's text
#   counterfactual_soundness  every Revision's old/new appear in the argument's
#                             declared chain; final active values are all source
#   public_leakage            public payload: opening turn + safe metadata only;
#                             no future turns, no answer authority, no gold
#   oracle_success            evaluator accepts the gold answer / gold patch
#   wrong_answer_failure      evaluator rejects a constructed wrong submission
#   provenance_present        record has a non-empty evidence ledger (upstream-
#                             import records are rejected here — test-only)
#   deterministic_rebuild     independent schedule+render from the same frozen
#                             inputs renders identical bytes

# ── parallax/run.py + parallax/evaluate.py ── Stage 5 ───────────────────────

async def run(
    arm: RenderedConversation, *, agent: ModelCallback, evaluator: NativeEvaluator,
) -> Verdict:
    """Deliver user turns in order (public first, sealed unlocked one per step —
    upstream IntentSample.reset()/step() semantics), collect the transcript,
    then grade ONLY the final assistant response with the native evaluator."""

class NativeEvaluator(Protocol):
    evaluator_id: str
    def identity(self) -> dict[str, str]: ...   # versions, image digests — sealed
    def grade(self, record: SourceRecord, final_response: str) -> EvalVerdict: ...

@dataclass(frozen=True)
class Verdict:
    task_id: str
    evaluator_id: str
    outcome: GradeOutcome            # SCORED | INVALID_SUBMISSION | HARNESS_ERROR
    reward: float
    transcript_digest: str
    raw: EvalVerdict                 # parsed answer / executed rows / test report
```

Call-chain audit: `generate` → `construction/pipeline` → three stage modules
(one file each). `build` → `family` → `schedule` + `render`. `run` → `run` +
one evaluator. No path crosses more than three files.

---

## 5. Stage flows (retries, escalation, evidence, errors)

### 5.1 Extraction (Stage 1)

```
load pinned record (domain)                          # network only for dataset fetch,
                                                     # pinned revision, cached
loop attempt 1..max_attempts:
  decompose        LLM(json)  ──rejected──▶ evidence(REJECTED_VALIDATION), retry
  to_conversational LLM(json)
  verify_coverage  LLM(judge) ──fail──▶ stash extraction, retry
  verify_solvability LLM(solve)×num_runs, majority ──fail──▶ retry
fallbacks: (2) judge-pass on best coverage-passing; (3) solvability on
coverage-failed stash                                # upstream 2nd/3rd pass
error: ExtractionFailed carries the record id + evidence span; generation of
this record aborts cleanly, ledger still frozen for post-mortem.
```

### 5.2 Counterfactuals (Stage 2)

Per argument × per variant: generate → parse JSON → construct `Counterfactual`
(constructor enforces value-swap laws) → on rejection, retry with the rejection
reason appended verbatim to the prompt (upstream feedback loop) → dedup against
accepted variants. All attempts (accepted and rejected) are evidence.

### 5.3 Predecessors (Stage 3)

As specified in §4 `generate_predecessor_chain`. Two retry scopes, upstream
semantics: *candidate-scope* (regenerate one predecessor, escalating to
`fallback_model` after half the attempts) and *chain-scope* (cross-turn
relevance failure regenerates the chain; independence failure regenerates only
fabricated arguments with structured feedback). Independence verdicts (per-run
answers with/without fabricated arguments) are individually evidenced.

### 5.4 Freeze

`ExpandedRecord` assembled, canonicalized, digested, written content-addressed
with `expanded.lock` (path + sha256 per file). After this point no provider
exists in the process: `schedule`, `render`, `build`, and locked replay import
nothing from `parallax.provider` (enforced by an import-graph test).

### 5.5 Schedule → render → admit (Stage 4)

Deterministic; errors are typed (`PlanInfeasible`, `PlanTamperedError`,
`AdmissionError` with named failing checks). Feasibility errors surface *before*
build publishes anything.

### 5.6 Run → evaluate (Stage 5)

Agent exceptions and evaluator harness failures produce `Verdict` with
`HARNESS_ERROR` (never a silent zero). SWE grading runs the upstream harness
against the pinned image; the image digest was committed at build time, so a
drifted harness fails identity, not silently regrades.

---

## 6. Domain adapter contract

```python
class Domain(Protocol):
    name: str
    profile: DomainProfile            # prompt pack path, archetype names,
                                      # prefix-pool id, answer format, share ranges

    # record boundary
    def load_record(self, record_id: str) -> SourceRecord: ...

    # Stage 1 (LLM-backed; receive RecordingProvider)
    def decompose(self, source, provider) -> Decomposed: ...
    def to_conversational(self, source, decomposed, provider) -> Conversational: ...
    def verify_coverage(self, source, extracted, provider) -> bool: ...
    def verify_solvability(self, source, extracted, provider) -> bool: ...

    # Stage 3 domain hooks
    def independence_check(self, function, arguments, fabricated, answer,
                           provider) -> IndependenceVerdict: ...

    # Stage 4 hooks (pure)
    def post_fill_hook(self, slots: MutableSlots, record: ExpandedRecord) -> None: ...
    def turn_one_context(self, record: ExpandedRecord) -> str | None: ...
    def per_turn_gold(self, record, plan) -> tuple[TurnGold, ...] | None: ...

    # Stage 5
    def evaluator(self) -> NativeEvaluator: ...
```

Defaults: `post_fill_hook` no-op, `turn_one_context` None, `per_turn_gold`
None, `independence_check` solve-and-compare via the domain evaluator. A
minimal domain implements `load_record`, the four Stage-1 methods (mostly by
pointing at a prompt pack), and `evaluator`.

**What cannot be generalized — and is therefore explicitly a hook, not kernel
logic:**

| Domain | Irreducible detail | Seam |
|---|---|---|
| GSM8K | numeric answer normalization; math solvability verifier | evaluator + Stage-1 methods |
| BIRD-SQL | per-turn partial gold via SQL AST stripping + live db execution; schema/evidence on turn 1; SQL extraction not loaded from HF (`extract_selected`) | `per_turn_gold`, `turn_one_context`, `load_record` |
| BrowseComp+ | BM25 corpus retrieval frozen across independence A/B; LLM-judge answer equivalence; encrypted-source loading | `independence_check`, `evaluator`, `load_record` |
| SWE-bench | impl-precursor pairing (predecessors are real paired bugs, not free-text generations); symptom-argument front-loading; developer prefix pools; mini-agent scaffold; docker harness with per-instance images | `load_record`, `post_fill_hook`, `profile.prefix_pools`, `evaluator` |

The kernel never branches on domain names. The one upstream wart we do **not**
port: upstream threads `is_sql_sample()` checks through the scheduler; here
that becomes `turn_one_context`/`per_turn_gold` hooks so the scheduler stays
domain-blind.

---

## 7. Scheduler and renderer ownership

- `schedule.py` owns *when and what*: event placement, deadlines, deferral,
  intent-state trajectory. It never produces prose. Output is `ConversationPlan`
  of `TurnPlan`s — pure typed state.
- `render.py` owns *how it's said*: prefix pools, casing, joins, recaps, domain
  system prompts. It consumes only `TurnPlan + ExpandedRecord + seed`. Because
  `TurnPlan` cannot carry free text, every rendered message is derived from
  typed state by construction — the correction predicate's "schedule turns from
  typed intent state" is a type-level guarantee, not a convention.
- Prefix pools are versioned data (`prefixes/{pool}.json`, digest-pinned into
  family identity), not code, so wording changes are visible as identity changes.

---

## 8. Native evaluator boundary and identity commitment

One protocol (`NativeEvaluator`), four implementations wrapping the *source
benchmarks'* evaluation logic (GSM8K normalized numeric match, BIRD-SQL
execution-result comparison, BrowseComp LLM-judge, SWE-bench test harness).
The evaluator's `identity()` — harness version, docker image digests, judge
model id, math-verify version — is captured at **build** time into the family's
sealed payload and certificate. `run` refuses to grade if the runtime
evaluator's identity differs from the committed one. Reward semantics: only the
final assistant response is graded (upstream protocol); the transcript digest is
recorded so graded runs are auditable.

---

## 9. Migration plan — delete, don't dual-path

Ordered; each step lands with its tests. No compatibility shims; callers are
in-repo only.

1. **Land the deterministic plane against upstream fixtures** (`record.py`,
   `intent.py`, `schedule.py`, `render.py`, `family.py` with admission v2,
   `domains/gsm8k.py`). `from_upstream_json` + characterization tests give real
   inputs before any provider code exists.
2. **Delete the shortcut intent models the moment step 1 is green:**
   - `evolving_intent.py` — `ProposalBundle`, `Reveal/Revise/Switch`,
     `compile_plans`, `replay_plan`, `_ANCHOR_GOAL` and the frozen-proposal
     format: **deleted** (the fixture format was the fabrication vector).
   - `kernel.py` — replaced by `family.py`; `AdmissionError`, lock/store/atomic
     publish code moves over; GSM8K-specific checks (`_known_wrong_answer`)
     move into `domains/gsm8k.py`.
   - `swebench.py` `compile_swebench_arms` + `SweBenchIntentArm` — **deleted**;
     `SweBenchSource/Verifier` shapes fold into `domains/swebench.py`'s
     `SourceRecord.native` parsing.
   - `variants.py` intent vocabulary (`IntentEvent`, `IntentAnchor`,
     `AnchorTrajectory`) — **deleted**. Recipe/variant machinery unrelated to
     intent stays untouched.
   - `autoresearch.py` — **demoted** to `experiments/autoresearch/` as a frozen
     historical experiment; its hand-rendered `render_conversation` is barred
     from `src/parallax` (it is a renderer that doesn't derive from typed state).
   - Fixtures `tests/fixtures/synthesis_kernel/proposal.json` (placeholder
     digests) — **deleted**, along with `test_synthesis_kernel.py`'s
     self-consistency tests; replaced by the harness in §10.
   - README/NOTES claims of Evolving Intent compatibility — rewritten to state
     exactly what is ported and against which upstream revision.
3. **Land the construction plane** (`provider.py`, `construction/`), GSM8K
   end-to-end first.
4. **Port remaining domains** in order BIRD-SQL → BrowseComp+ → SWE-bench (each
   is additive: one module + prompt pack + evaluator).
5. **Keep**: `ids.py` unchanged; `grading.py` outcome enum absorbed into
   `evaluate.py`; `gsm8k.py`'s answer parser survives inside
   `domains/gsm8k.py` (it is genuinely good).

At no point do two intent models coexist on `main` for more than one commit
series; step 2 is a hard cutover gated on step 1's parity tests.

---

## 10. Verification harness (designed before implementation)

Test layers, cheapest first. All fixtures are *real artifacts* with recorded
provenance; hand-authored proposals are structurally impossible (§3).

1. **Upstream characterization (scheduling parity — the falsifiable core).**
   Vendor 3–5 records from upstream's pipeline output shape (regenerated once
   with the live smoke test, or imported from upstream `final_dataset` if
   published) as `tests/fixtures/upstream/*.json`, pinned to `993d6be…`. A
   characterization script (checked in, runnable against a checkout of the
   upstream repo) executes upstream `create_sample(raw, g, p, t, mode="eval",
   seed)` across a grid of scenarios and dumps `{turn_texts, change_plan}`.
   Tests assert our `schedule`+`render` reproduce, for every grid point:
   turn count, per-turn event types, revealed-id sets, active-value maps,
   correction chain values, final-state restoration, and (for the rule-based
   renderer with pinned prefix pools) the exact turn texts. Divergence is a
   test failure with a structural diff — algorithm parity, mechanically checked.
2. **Deterministic fake provider (construction plane, offline).**
   `DeterministicFakeProvider` fixtures cover: happy path; coverage failure →
   retry; 2nd/3rd-pass fallbacks; counterfactual validation rejection →
   feedback retry; predecessor similarity/leakage rejection; escalation to
   fallback model at attempt max//2 (asserted via evidence ledger `model`
   fields); independence failure → feedback regeneration. Assertions run
   against the frozen `ExpandedRecord`: evidence completeness (every provider
   call present, digests consistent), verification summary correctness.
3. **Negative ignore-history control (invalidates the terminal-dump failure
   mode forever).** Structural: admission's `terminal_reconstruction` check has
   its own tests, including a constructed adversarial plan whose final turn
   embeds the full question — must be rejected. Behavioral: a `LastTurnOnly`
   agent (answers using only the final user message) must score 1.0 on the
   `fully_specified` arm and 0.0 on `argument_reveal`/`combined` arms of the
   fake-provider GSM8K family, because required arguments live only in history.
   If that agent ever passes an evolved arm, the experiment is invalid and CI
   says so.
4. **Replay and identity property tests.** Tampering with any turn, revision
   value, or state snapshot → `PlanTamperedError`; locked rebuild is
   byte-identical and network-free (socket-monkeypatch, carried over from the
   current suite — the one part of the old tests worth keeping); import-graph
   test that `schedule`/`render`/`family` cannot import `provider`.
5. **Live generation smoke test (gated, `PARALLAX_LIVE_SMOKE=1`).** One pinned
   GSM8K record through `generate` with a real provider → assert the record
   freezes, admits, builds all scenarios, and the oracle passes the native
   evaluator; artifacts uploaded for manual inspection and for refreshing
   layer-2 fixtures. This is the only networked test.

---

## Rationale

### Problem

(§1 above; constraints: freeze-boundary preservation, verification predicate,
upstream fixture compatibility, four-model consolidation.)

### Usage (caller's view)

(§2 above — written first; the types in §3 were derived from it.)

### Shape

The load-bearing decision is **one freeze boundary, placed where upstream's own
determinism boundary is**: between Stage 3 and Stage 4. Everything stochastic
(three generation stages, all judges, all retries) lives in `construction/`
behind `generate()` and exits only as a frozen `ExpandedRecord` with a complete
raw-evidence ledger. Everything below (`schedule`, `render`, `family`, `run`)
is pure and replayable, which is exactly what Parallax's existing sealing
machinery is good at — it keeps its job, pointed at real inputs.

Second decision: **the intent model is upstream's formalization and there is
exactly one of it** (`intent.py`). Scheduler output is typed state
(`TurnPlan`/`IntentState`); the renderer is the only producer of prose. This
makes the two audit-fatal bugs unrepresentable: a terminal full-question dump
has no encoding (plans carry no text), and replay validates argument-state
restoration because states are recomputed from transitions, not compared to a
sentinel (per encode-lessons-in-structure).

Third: **domains are deep adapters, not a plugin framework.** The `Domain`
protocol is closed and small (load, four Stage-1 methods, three pure Stage-4
hooks, evaluator); the table in §6 names precisely which upstream details
refuse to generalize and pins each to one hook. The kernel never branches on
domain names (per boundary-discipline: wire formats — upstream JSON, HF
datasets, docker harness output — are parsed into domain types at the edge).

Interface depth: the public surface is five functions (`generate`, `build`,
`run`, `schedule`, `render`) plus two protocols (`Domain`, `Provider`) and the
frozen data types. Hidden behind it: three-stage retry/escalation/judge
orchestration, evidence capture, the five-step scheduler with its deadline and
deferral logic, prefix-pool rendering, admission, content-addressed storage,
and four native harnesses. Callers coordinate nothing across calls; each of
the three verbs is a complete operation.

Deliberately not done: no train-mode random sampling (eval-mode determinism
only, until a training consumer exists); no online LLM naturalizer in v1
(rule-based renderer only — naturalization reintroduces a provider above the
freeze line and needs its own evidence design); no checkpoint/workspace
runtimes carried forward.

### Synthesis decision

*(left for arena)*

### Tradeoffs accepted

- **We accept a heavier `ExpandedRecord` (full raw responses sealed inside) in
  exchange for post-hoc auditability and offline re-parsing.** Records are
  per-benchmark-item; size is bounded and content-addressed.
- **We accept porting ~600 lines of subtle scheduler logic (deadlines,
  stealing, stale-text fixes) rather than simplifying it**, in exchange for
  mechanical characterization parity with upstream. Simplifying first would
  make parity unfalsifiable.
- **We accept deleting the frozen-proposal format and its tests with no
  migration path**, in exchange for making fabricated provenance
  unrepresentable. Nothing real depends on the old format; it was only ever
  populated by hand.
- **We accept that upstream-imported records can never ship in a family**
  (admission rejects empty evidence), in exchange for a clean line between
  parity fixtures and production artifacts.
- **We accept re-running provider calls on generation retry rather than
  caching by prompt digest**, in exchange for an evidence ledger that reflects
  what actually happened; dedup-caching would silently alias distinct attempts.

### Alternatives considered

- **Vendor upstream as a library and wrap it** (import `create_sample`,
  `PredecessorGenerator` directly; Parallax only seals inputs/outputs). Hides
  the most complexity for the least code, but the interface upstream exposes is
  dict-shaped and printf-verified: no typed state, no evidence capture without
  monkeypatching `llm_utils`, no way to make invalid plans unrepresentable, and
  Python-version/dependency coupling (upstream pins py3.10 + openai SDK).
  Callers would inherit upstream's leakage (raw dicts everywhere). Rejected:
  shallow module over a wide, unstable surface. It survives as the
  *characterization oracle* in the harness instead — the right job for it.
- **Event-sourced single model** (extend today's `Reveal/Revise/Switch` events
  to cover extraction/counterfactual/predecessor stages; one append-only event
  log from generation through rendering). Elegant identity story, but it maps
  poorly onto upstream: the scheduler is constraint-solving over a whole plan
  (deadlines, stealing), not event-at-a-time, so parity would require
  reconstructing plans from events anyway — a second representation to keep in
  sync (violates single-source-of-truth). Exposes event-log complexity to every
  reader for no depth gain. Rejected.
- **Per-domain pipelines** (four vertical `gsm8k_pipeline.py`-style modules
  sharing only the provider and the store; no common scheduler). Honest about
  how much upstream itself special-cases domains, and each pipeline is simple.
  But upstream's scheduler *is* shared across domains (SWE goes through
  `create_sample` with a hook), so this shape duplicates the hardest logic
  four times and makes "add a domain without touching the kernel" false by
  construction. Rejected: information leakage of scheduler invariants into
  every domain.

### Open questions and risks

- Upstream `final_dataset/*.json` may not be published in the repo. Is
  regenerating characterization fixtures via the live smoke test (with our
  keys, at pinned prompts) acceptable provenance for the parity suite, or do we
  need to request the paper's artifacts?
- Exact-text parity in layer 1 depends on reproducing upstream's eval-mode
  prefix-cycling counters precisely. If any pool selection turns out to be
  order-dependent on Python dict iteration in upstream, do we pin to observed
  behavior (bug-for-bug) or to documented intent? Recommendation: bug-for-bug,
  recorded in the characterization fixtures.
- BIRD-SQL requires a local database tree and BrowseComp+ an encrypted corpus;
  both are heavyweight. Is it acceptable for those domains' `load_record` to
  require a prepared data root (documented, digest-pinned) rather than
  auto-download?
- SWE-bench predecessors upstream come from *paired real bugs*
  (`pair_swe_bugs.py`), not free generation. v1 scopes SWE to
  reveal/revision scenarios plus impl-precursor switches only where pairing
  data exists — confirm that scope is acceptable for the milestone.
- `output_tokens_per_turn` budget: upstream does not enforce a per-turn output
  budget; Parallax's matched-budget idea came from the old design. Keep it as
  an optional run-time constraint (not identity-bearing), or drop it?

### Next implementation step

Write `intent.py` + `schedule.py` with `replay()`, plus
`ExpandedRecord.from_upstream_json`, and bring up the layer-1 characterization
harness against upstream `create_sample` on one GSM8K fixture — everything else
stacks on that parity signal.

---

## Red-flag self-screen

- **Shallow module**: the three public verbs each hide a full pipeline stage;
  no caller sequences internal steps (generate/build/run are complete
  operations). `Domain` is the widest surface (9 methods) but each method owns
  real domain knowledge; defaults keep minimal domains at 6.
- **Information leakage**: upstream JSON schema is parsed once in `record.py`;
  provider wire types stay inside `provider.py`; prefix strings live in
  versioned data files consumed only by `render.py`; evaluator harness details
  stay behind `NativeEvaluator`. No module re-exports transport types.
- **Temporal decomposition**: `construction/` is organized by *validation
  knowledge owned* (extraction gates vs. value-swap laws vs. chain
  archetypes/independence), which happens to align with execution order because
  upstream's stages are genuinely different bodies of knowledge; the
  deterministic plane is organized by ownership (state vs. text vs. identity),
  not order — `schedule` and `replay` live together because they protect the
  same invariants.
- **Pass-through methods**: `parallax.generate` delegates to
  `construction.pipeline.generate` — kept because the package boundary is the
  public/private line, and it adds the store/freezing policy. No other
  forwarding layers exist; `runtime_for`-style indirection from the old kernel
  is gone.
