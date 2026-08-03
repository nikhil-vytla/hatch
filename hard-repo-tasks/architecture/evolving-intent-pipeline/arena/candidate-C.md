# Candidate C — Ledger-first paper-state kernel

Pinned upstream: `microsoft/evolving-intent@993d6be9597ac03854b46362ccd647eb1bfd267a`.

Structural thesis: generation is a content-addressed evidence ledger; the
deterministic kernel is the paper's `UserIntent` / `IntentTransition` /
`ChangePlan` state machine; domains are a closed enum of sealed adapter
modules, not a plugin registry. Messages are projections of typed schedule
state, never the source of truth.

---

## Problem

Parallax's synthesis-kernel slice proved sealing, admission, and locked replay
on a hand-authored `ProposalBundle`, not Microsoft Evolving Intent. The shortcut
invents Reveal/Revise/Switch events, anchors replay on a magic goal
(`answer_source_task`), and terminates by dumping the full source question —
which removes the paper's central pressure to restore active arguments from
history. There is no extraction, counterfactual generation, chained predecessor
generation, plan-first scheduler, or domain renderer. Four conflicting intent
models coexist (`evolving_intent`, `variants`, `autoresearch`, `swebench`), the
kernel is GSM8K-hardcoded, SWE is disconnected, and fixtures fabricate
provenance digests. The corrected definition of done requires real
provider-backed stages from a pinned benchmark record through native final
evaluation, with stochastic intermediates frozen and deterministic identity /
admission / locked replay below that boundary. Exact conversation text parity
with the paper is not required; algorithmic and fixture compatibility with the
pinned upstream are.

Constraints the design must honor:

- Keep `parallax.ids` (`canonical_bytes`, `digest_value`, `task_id_for`) as the
  single identity implementation.
- Keep content-addressed family artifacts, admission certificates, and lock
  files as the deterministic publish path.
- Support GSM8K, BIRD-SQL, BrowseComp+, SWE-bench Verified through explicit
  domain seams without changing the common kernel.
- Delete or demote the shortcut APIs; do not maintain permanent dual paths that
  claim Evolving Intent compatibility.

---

## Usage (caller's view)

Callers import four verbs and one domain token. They never call extract /
counterfactual / predecessor / schedule / render stages directly.

```python
from pathlib import Path
from parallax.evolving import Domain, Generate, Admit, Run
from parallax.evolving.provider import OpenAIProvider  # or FakeProvider in tests

# 1) Generate — stochastic; freezes a Construction from a pinned source
provider = OpenAIProvider(model="gpt-5.1")
construction = Generate(
    domain=Domain.GSM8K,
    provider=provider,
    upstream_revision="993d6be9597ac03854b46362ccd647eb1bfd267a",
).from_pin(
    dataset="openai/gsm8k",
    revision="e53f048856ff4f594e959d75785d2c2d37b678ee",
    split="test",
    item_id="test:0",
    num_counterfactuals=4,
    num_predecessors=3,
)
construction.write(Path("store/constructions") / construction.construction_id)

# 2) Admit / build — deterministic; no provider
family = Admit(construction).family(
    scenario=Admit.Scenario(
        num_turns=4,
        num_revisions=2,
        num_switches=1,  # → combined; inferred if omitted when consistent
        mode="eval",
        seed=0,
        output_tokens_per_turn=256,
    )
)
# or locked rebuild:
family = Admit.from_lock(Path("experiment/family.lock"), store=Path("store"))

# 3) Run — native evaluator scores the terminal response only
async def agent(messages):
    return "#### 72"

verdict = await Run(family.arm("evolved")).with_agent(agent)
assert verdict.reward in {0.0, 1.0}
```

Matched and static arms are produced by the same admit path (no separate
generator). Matched uses the same turn budget with zero revisions/switches and
reveal-only or fully-specified content as upstream's control logic requires;
static is the fully-specified one-turn baseline.

Custom non-paper domain (closed enum extension, not a plugin hook):

```python
# parallax/domains/recipe_click.py — new sealed module
from parallax.evolving import Domain, Generate, Admit, Run
from parallax.evolving.seams import register_domain  # compile-time registration only

@register_domain(Domain.RECIPE_CLICK)  # Domain enum member added in same PR
class RecipeClickSeam:
    """Owns Click counterfactual-recipe extraction, prefixes, and harness score.
    Cannot reuse GSM8K numeric verify or SWE workspace persistence.
    """
    ...

construction = Generate(Domain.RECIPE_CLICK, provider).from_pin(...)
family = Admit(construction).family(scenario=...)
verdict = await Run(family.arm("evolved")).with_agent(agent)
```

Adding a domain requires: (1) a `Domain` enum member, (2) one seam module, (3)
tests. It must not edit `schedule.py`, `admit.py`, or `state.py`.

---

## Shape

### Load-bearing decisions

1. **Paper state is the only intent model.** `Argument`, `UserIntent`,
   `IntentTransition` (`argument_reveal` | `argument_change` | `function_change`),
   and `ChangePlan` match upstream `situated_simulation/user_intent.py`. The
   shortcut's Reveal/Revise/Switch and magic `answer_source_task` goal are
   deleted, not aliased. (`encode-lessons-in-structure`)

2. **GenerationLedger is the freeze boundary.** Every provider call becomes an
   immutable `ProviderTrace` (prompt bytes digest, raw response text, model,
   temperature, attempt, stage, parse status). Parsed stage outputs are sealed
   only after validation. Stochastic work stops at `Construction`; admit/run
   never call a provider. (`boundary-discipline`)

3. **Domains are a closed enum, not a plugin framework.** `Domain` is a
   `StrEnum` with four paper members plus explicitly added custom members.
   Each member maps to exactly one seam module that owns non-generalizable
   prompts, validation, predecessor archetypes, prefix banks, runtime kind,
   and native scoring. The kernel never `importlib`-discovers plugins.
   (`subtract-before-you-add`, reject vague plugin frameworks)

4. **Scheduler owns WHAT; renderer owns HOW.** Plan-first scheduling ports
   upstream `turn_scheduler.create_sample` steps 0–3 into typed
   `TurnBlueprint` / `TurnSlot` / `TurnEvent` / `ArgumentItem` structures.
   Rendering (step 4) and domain prefix selection produce message text from
   that blueprint. Storing free-floating turn strings without a blueprint is
   a type error. (`single source of truth`)

5. **Messages are projections.** `RenderedArm.messages` is derived by
   `render(blueprint, prefixes, recap)` and re-derivable. Public payloads
   expose only opening_turn + safe metadata; sealed payloads hold blueprint,
   change plan, construction digest, and verifier material.
   (`boundary-discipline`)

6. **Terminal restoration is structural, not string copy.** The final
   `UserIntent` must restore `function == source_function` and every active
   argument value to its source text. The terminal user message is the
   *rendered restoration turn* from that state (function-change to source
   and/or final corrections), never a dump of the original benchmark
   question. Admission rejects any arm whose final intent is not fully
   restored. (`encode-lessons-in-structure`)

7. **Public surface is three verbs.** `Generate`, `Admit`, `Run` hide retries,
   model escalation, stage ordering, scheduling, sealing, and admission.
   Callers coordinate one operation per verb. (`interface depth`)

### Core data shapes

Invalid states are unrepresentable where practical.

```python
# parallax/evolving/state.py — paper types (deterministic kernel)

class Domain(StrEnum):
    GSM8K = "gsm8k"
    BIRD_SQL = "bird_sql"
    BROWSECOMP_PLUS = "browsecomp_plus"
    SWE_BENCH_VERIFIED = "swe_bench_verified"
    # custom members added only with a seam module in the same change
    RECIPE_CLICK = "recipe_click"  # example non-paper domain

@dataclass(frozen=True)
class Argument:
    argument_id: int                      # >= 1
    source_text: str                      # non-empty
    counterfactual_variants: tuple[str, ...]
    is_shared: bool = False
    category: str | None = None           # SWE: symptom|trigger|...; else None

@dataclass(frozen=True)
class UserIntent:
    function: str
    arguments: tuple[Argument, ...]       # full universe C; non-empty
    revealed_ids: frozenset[int]          # ⊆ argument ids
    target_answer: str                    # "" when unknown mid-trajectory
    active_values: tuple[tuple[int, str], ...]  # only non-source actives

    def __post_init__(self) -> None: ...  # revealed ⊆ ids; active ids ⊆ ids

class TransitionType(StrEnum):
    ARGUMENT_REVEAL = "argument_reveal"
    ARGUMENT_CHANGE = "argument_change"
    FUNCTION_CHANGE = "function_change"

@dataclass(frozen=True)
class IntentTransition:
    transition_type: TransitionType
    revealed_ids: tuple[int, ...] = ()
    changed_arguments: tuple[tuple[int, str, str], ...] = ()  # id, old, new
    old_function: str | None = None
    new_function: str | None = None

    def __post_init__(self) -> None:
        # function_change requires old/new; argument_change requires changes; etc.

class ScenarioKind(StrEnum):
    FULLY_SPECIFIED = "fully-specified"
    UNDER_SPECIFIED = "under-specified"      # aka argument-reveal
    ARGUMENT_REVISION = "argument-revision"
    FUNCTION_SWITCH = "function-switch"
    COMBINED = "combined"

@dataclass(frozen=True)
class ChangePlan:
    task_id: str
    scenario: ScenarioKind
    domain: Domain
    intent_trajectory: tuple[UserIntent, ...]   # len >= 1
    transitions: tuple[IntentTransition, ...]   # len == len(trajectory) - 1
    final_label: str

    def __post_init__(self) -> None:
        # final intent fully specified; function == source; no counterfactual actives
        # final_label == trajectory[-1].target_answer
```

```python
# parallax/evolving/ledger.py — freeze boundary

class Stage(StrEnum):
    EXTRACT_DECOMPOSE = "extract.decompose"
    EXTRACT_CONVERSATIONAL = "extract.conversational"
    EXTRACT_COVERAGE = "extract.coverage"
    EXTRACT_SOLVABILITY = "extract.solvability"
    EXTRACT_JUDGE = "extract.judge"
    COUNTERFACTUAL = "counterfactual"
    PREDECESSOR = "predecessor"
    # domain-specific extras (SWE patch alignment, SQL rewrite, …) stay stage-tagged

@dataclass(frozen=True)
class ProviderTrace:
    stage: Stage
    attempt: int
    model: str
    temperature: float
    prompt_digest: str          # sha256 of canonical prompt messages
    raw_response: str           # full raw text; sealed into construction
    raw_response_digest: str    # digest_value(raw_response)
    parsed: Mapping[str, CanonicalValue] | None
    accepted: bool
    error: str | None

@dataclass(frozen=True)
class ExtractionRecord:
    function: str
    arguments: tuple[Argument, ...]       # variants empty at this stage
    # domain extras as sealed opaque blob keyed by Domain, not free-form kwargs
    domain_payload: CanonicalValue

@dataclass(frozen=True)
class CounterfactualRecord:
    by_argument: tuple[tuple[int, tuple[CounterfactualVariant, ...]], ...]

@dataclass(frozen=True)
class CounterfactualVariant:
    counterfactual_argument: str
    original_value: str
    counterfactual_value: str
    reasoning: str

@dataclass(frozen=True)
class PredecessorRecord:
    predecessors: tuple[PredecessorFunction, ...]  # nearest-first storage

@dataclass(frozen=True)
class PredecessorFunction:
    predecessor_function: str
    taxonomy_type: str                  # T1..T4
    transition_reason: str
    is_predecessor: bool
    counterfactual_arguments: tuple[Argument, ...]  # shared flags set
    transition_phrase: str | None = None            # SWE impl-precursor
    transition_type: str | None = None              # SQL llm_multi_clause

@dataclass(frozen=True)
class Construction:
    format: Literal["parallax.construction.v1"]
    construction_id: str
    upstream_revision: str
    domain: Domain
    source_digest: str
    verifier_digest: str
    source_function: str
    source_arguments: tuple[Argument, ...]  # with counterfactual_variants filled
    predecessors: tuple[PredecessorFunction, ...]
    traces: tuple[ProviderTrace, ...]       # complete evidence; non-empty
    generation: GenerationConfig
    # domain sealed extras (schema, db_path, repo, FAIL_TO_PASS, …)
    domain_sealed: CanonicalValue

    def __post_init__(self) -> None:
        # construction_id == digest of sealed_payload(); traces cover all stages
        # every argument with eligibility has >= configured variants or explicit skip
        # final source_function non-empty; arguments non-empty
```

```python
# parallax/evolving/schedule_types.py — plan-first blueprint

@dataclass(frozen=True)
class TurnEvent:
    type: Literal["function_init", "function_change", "correction"]
    function_idx: int | None = None   # -1 source; >=0 into selected predecessors
    cond_id: int | None = None
    corr_step: int | None = None
    corr_text: str | None = None

@dataclass(frozen=True)
class ArgumentItem:
    cond_id: int
    text: str
    is_counterfactual: bool = False

@dataclass(frozen=True)
class TurnSlot:
    turn_idx: int
    events: tuple[TurnEvent, ...]
    arguments: tuple[ArgumentItem, ...]
    function_text: str | None

@dataclass(frozen=True)
class TurnBlueprint:
    slots: tuple[TurnSlot, ...]
    selected_predecessors: tuple[PredecessorFunction, ...]  # farthest-first order used
    counterfactual_map: tuple[tuple[int, tuple[CounterfactualVariant, ...]], ...]
    g: int
    p: int
    t: int

@dataclass(frozen=True)
class Scenario:
    num_turns: int
    num_revisions: int = 0
    num_switches: int = 0
    mode: Literal["eval", "train"] = "eval"
    seed: int = 0
    recap_method: Literal["prompt", "dump", "ground_truth"] | None = None
    output_tokens_per_turn: int = 256
    naturalize: Literal["rule"] = "rule"  # LLM naturalizer out of v1 admit path

class ArmName(StrEnum):
    STATIC = "static"
    MATCHED = "matched"
    EVOLVED = "evolved"

@dataclass(frozen=True)
class RenderedArm:
    arm: ArmName
    blueprint: TurnBlueprint
    change_plan: ChangePlan
    messages: tuple[ConversationMessage, ...]  # derived; re-renderable
    budget: TurnBudget
    public_digest: str
    sealed_digest: str
    task_id: str

@dataclass(frozen=True)
class Family:
    family_id: str
    construction_id: str
    source_digest: str
    verifier_digest: str
    arms: tuple[RenderedArm, ...]
    certificate: AdmissionCertificate
```

### Function signatures and module ownership

```
parallax/
  ids.py                         # KEEP — sole identity
  grading.py                     # KEEP — GradeOutcome
  evolving/
    __init__.py                  # export Domain, Generate, Admit, Run
    api.py                       # Generate, Admit, Run — public verbs
    state.py                     # Argument, UserIntent, IntentTransition, ChangePlan
    ledger.py                    # ProviderTrace, Construction, load/write
    provider.py                  # Provider protocol, OpenAIProvider, FakeProvider
    construct.py                 # stage orchestration over DomainSeam + Provider
    schedule.py                  # plan-first scheduler (typed port of create_sample)
    render.py                    # blueprint + PrefixBank → messages; build ChangePlan
    admit.py                     # Family, admission checks, locks, artifact store
    evaluate.py                  # Run → Verdict via DomainSeam.score
    seams.py                     # DomainSeam protocol + closed registry
  domains/
    gsm8k/
      seam.py                    # extract, CF, pred, prefixes, score
      prompts/                   # vendored/adapted from upstream prompts
    bird_sql/
      seam.py
      sql_partial.py
    browsecomp_plus/
      seam.py
    swe_bench_verified/
      seam.py                    # includes post_fill_hook + workspace runtime
      precursors.py              # G1 orientation / G2 impl-plan generation
```

Public API:

```python
# parallax/evolving/api.py

class Generate:
    def __init__(self, domain: Domain, provider: Provider, *, upstream_revision: str) -> None: ...
    def from_pin(self, **pin_and_budget) -> Construction: ...
    def from_source(self, source: SourceRecord, *, num_counterfactuals: int, num_predecessors: int) -> Construction: ...

class Admit:
    def __init__(self, construction: Construction) -> None: ...
    def family(self, scenario: Scenario) -> Family: ...
    @classmethod
    def from_lock(cls, lock: Path, *, store: Path) -> Family: ...

class Run:
    def __init__(self, arm: RenderedArm) -> None: ...
    async def with_agent(self, agent: ModelCallback, *, workspace: Workspace | None = None) -> Verdict: ...
```

Domain seam (knowledge ownership, not temporal stages):

```python
# parallax/evolving/seams.py

class DomainSeam(Protocol):
    domain: Domain
    runtime: Literal["conversation", "workspace"]

    def load_pin(self, pin: SourcePin) -> SourceRecord: ...
    def extract(self, source: SourceRecord, llm: Provider, cfg: ExtractConfig) -> tuple[ExtractionRecord, tuple[ProviderTrace, ...]]: ...
    def counterfactuals(self, source: SourceRecord, extraction: ExtractionRecord, llm: Provider, n: int, cfg: CFConfig) -> tuple[CounterfactualRecord, tuple[ProviderTrace, ...]]: ...
    def predecessors(self, source: SourceRecord, extraction: ExtractionRecord, cfs: CounterfactualRecord, llm: Provider, n: int, cfg: PredConfig) -> tuple[PredecessorRecord, tuple[ProviderTrace, ...]]: ...
    def prefix_bank(self) -> PrefixBank: ...
    def post_fill(self, slots: list[TurnSlot], ctx: ScheduleContext) -> list[TurnSlot]:
        """Default identity. SWE injects symptoms; others leave slots unchanged."""
        ...
    def score(self, source: SourceRecord, response: str, *, workspace: Workspace | None) -> NativeGrade: ...
    def system_prompt(self, source: SourceRecord) -> str | None: ...
    def wrap_opening(self, source: SourceRecord, content: str) -> str:
        """SQL schema/evidence prepend; others identity."""
        ...
```

Internal (not public) orchestration:

```python
# construct.py
def build_construction(seam: DomainSeam, source: SourceRecord, provider: Provider, cfg: GenerationConfig) -> Construction:
    # extract with retries/escalation → counterfactuals → predecessors
    # assemble Construction; compute construction_id; refuse incomplete traces
    raise NotImplementedError

# schedule.py
def schedule(construction: Construction, scenario: Scenario, seam: DomainSeam) -> tuple[TurnBlueprint, ChangePlan]:
    # port of select_functions / select_counterfactuals / schedule_events /
    # fill_arguments / fill_texts / build_change_plan + seam.post_fill
    raise NotImplementedError

# render.py
def render(blueprint: TurnBlueprint, plan: ChangePlan, seam: DomainSeam, scenario: Scenario) -> tuple[ConversationMessage, ...]:
    raise NotImplementedError

# admit.py
def admit_family(construction: Construction, scenario: Scenario) -> Family:
    raise NotImplementedError
```

### Full stage flows

#### Generate: extraction

```
SourceRecord
  → seam.extract
      for attempt in 1..max_attempts:
        decompose (LLM JSON) → trace
        to_conversational (LLM JSON) → trace
        coverage verify (LLM JSON) → trace; on fail continue
        solvability verify (domain-specific; may LLM-solve) → trace; on fail continue
        optional LLM-as-judge pass on best coverage-ok attempt
        optional coverage-failed + solvability-ok acceptance (upstream 3rd pass)
      on total failure → ConstructionError(stage=extract, traces=...)
  → ExtractionRecord
```

Model escalation (owned by `Provider` policy, not callers): after N failures on
the primary model, retry remaining attempts on `escalation_model` if configured.
Every attempt still emits a `ProviderTrace`.

#### Generate: counterfactuals

```
for each counterfactual-eligible argument:
  for variant in 1..n:
    for attempt in 1..max_attempts:
      LLM generate variant (with previous variants as negative examples)
      validate clean value-swap (forward reconstruction, containment, length)
      on fail: feed validation reason back into next prompt; trace accepted=False
    on success: append CounterfactualVariant; trace accepted=True
Domain overlays:
  GSM8K/BrowseComp: default value-swap validator
  BIRD-SQL: SQL-aware generator + executable checks where upstream does
  SWE: only location|approach|scope|constraint categories; symptoms ineligible
```

#### Generate: predecessors

```
chained generation farthest←nearest←source:
  G_{k} from G_{k+1} (k from n down to 1)
  share_range and taxonomy archetype selected by domain
  cross-turn leak checks on fabricated arguments
  SWE: replace generic chain with G1 orientation + G2 impl-plan specialized generators
  BIRD-SQL: SQL naturalizer / multi-clause rewrite path
Store nearest-first (upstream convention); scheduler reverses to farthest-first.
```

#### Admit: schedule + render + seal

```
Construction + Scenario
  → infer ScenarioKind from (g, p, t) exactly as upstream
  → schedule → TurnBlueprint + ChangePlan
  → assert final UserIntent fully restored to source function + source values
  → render → messages (rule-based prefixes from PrefixBank; deterministic under seed)
  → build static / matched / evolved arms
  → admission checks → Family → content-addressed store + optional lock
```

Retries: none in admit. Failures are hard errors (`ScheduleError`,
`AdmissionError`). Train mode randomness is seeded and recorded in the sealed
scenario block so locked rebuilds remain byte-identical.

#### Run: evaluate

```
RenderedArm
  → runtime = conversation | workspace from seam.runtime
  → for each user message in arm.messages:
        agent(transcript) → assistant message
  → seam.score(source, final_response, workspace=...)
  → Verdict(task_id, outcome, reward, response, parsed, turns_completed)
```

Errors: agent type errors raise; native grader returns scored 0 / invalid
submission — never silently substitutes a different evaluator.

### Domain adapter contract — what cannot be generalized

| Concern | Kernel-owned | Domain-owned (cannot generalize) |
|--------|--------------|-----------------------------------|
| Intent state machine | yes | — |
| Plan-first event placement | yes | SWE symptom strip/inject via `post_fill` only |
| Prefix *application* order | yes (function → correction → reveals) | Prefix *pools* and taxonomy routing |
| Extraction loop shape | yes (attempts, traces) | Prompts, coverage, solvability, categories |
| CF validation framework | yes (attempt + feedback) | Value-swap rules; SQL exec; SWE eligibility |
| Predecessor chaining shape | yes | Archetypes, SWE G1/G2, SQL rewrite |
| Opening wrap | hook | SQL schema/evidence; search instructions |
| Scoring | hook | GSM8K numeric; BIRD exec; BrowseComp judge; SWE harness |
| Runtime | dispatch on enum | conversation vs persistent workspace |

### Scheduler and renderer ownership

- `schedule.py` owns selection, deadlines, event interleaving, argument fill,
  correction chains, empty-slot trim/redistribute, and `ChangePlan` construction.
- `render.py` owns prefix selection from `PrefixBank`, join rules, recap text,
  system/opening wrap via seam hooks, and `ConversationMessage` tuples.
- `domains/*/seam.py` owns the `PrefixBank` constants (ported from upstream
  `user_simulation.py` domain prefix maps) and optional `post_fill`.
- Naturalization: v1 admit freezes **rule-based** renderings only. An optional
  later `Naturalize` verb may add LLM paraphrases as a *new* sealed layer with
  its own traces; it must not mutate an already-admitted Family in place.

### Native evaluator boundary and identity commitment

```
source_digest     = digest(source.public_payload)          # no answers/patches
verifier_digest   = digest(source.sealed_verifier_payload) # answers, tests, harness rev
construction_id   = digest(Construction.sealed_payload)    # includes all trace digests
arm.public_digest = digest({arm, budget, opening, source_digest, verifier_digest})
arm.sealed_digest = digest({blueprint, change_plan, construction_id, scheduled_tail, verifier})
task_id           = task_id_for(public_digest, sealed_digest)
family_id         = digest({policy, construction_id, arm task_ids, scenario sealed})
```

Native score commits to `verifier_digest` only. Changing the grader, gold
answer, test patch, or harness revision changes `verifier_digest` and therefore
every task_id. Construction traces are part of identity: regenerating with a
different raw response yields a new `construction_id` even if parsed fields
coincide.

Admission policy `evolving-intent-family.v1` checks:

1. `source_verifier_parity` — one source/verifier across arms
2. `terminal_intent_restored` — final UserIntent source function + source values;
   fully specified; `final_label` present
3. `no_terminal_question_dump` — final message ≠ raw source question text
   (except static fully-specified arm, where the opening *is* the full task)
4. `matched_evolved_budget` — equal turn/token budgets
5. `public_leakage` — no sealed fields / future turns in public payload
6. `oracle_success` / `wrong_answer_failure` — native evaluator sanity
7. `deterministic_locked_rebuild` — admit(construction, scenario) byte-identical
8. `trace_completeness` — every construction stage has accepted evidence
9. `change_plan_message_consistency` — re-render(blueprint) == sealed messages

### Migration plan (delete / demote, no dual path)

| Current artifact | Action |
|-----------------|--------|
| `parallax.evolving_intent.ProposalBundle` + Reveal/Revise/Switch | **Delete** after Construction exists; no compatibility shim that claims EI |
| `parallax.evolving_intent.compile_plans` terminal question append | **Delete** |
| `parallax.kernel.build(source, strategy=EvolvingIntent)` | **Replace** with `Admit(construction).family(...)`; old symbol raises `RemovedError` pointing to new API for one release, then delete |
| `parallax.gsm8k.SourceTask` | **Keep** as GSM8K `SourceRecord` implementation; lift shared pin fields into `evolving.source.SourceRecord` protocol |
| `parallax.swebench.compile_swebench_arms` hand schedules | **Delete**; SWE goes through Construction + schedule |
| `parallax.variants` IntentEvent / IntentAnchor | **Demote** — remains the *causal variant contracts* family, explicitly *not* Evolving Intent; rename module doc to forbid EI claims |
| `parallax.autoresearch` IntentCondition synthetic arithmetic/lookup | **Demote** — measurement harness for synthetic tasks only; not EI |
| Fixtures `proposal.json` with fabricated digests | **Replace** with `Construction` fixtures from FakeProvider characterization |
| Tests that only prove self-consistency of the shortcut | **Replace** with harness below |

One-release `RemovedError` stubs are allowed; permanent dual paths that both
claim Evolving Intent compatibility are not.

### Verification harness (designed before implementation)

Harness lives under `tests/evolving/` and must land before generation code is
considered done.

1. **Upstream characterization (no network)**  
   Vendor minimal frozen upstream JSON samples (extracted+CF+predecessor) from
   the pinned commit's expected shapes. Run a thin adapter that feeds them to
   our `schedule` + `render` and to a vendored copy of upstream
   `create_sample` (pinned file, not live clone). Assert equal: scenario kind,
   g/p/t, transition types sequence, final restored function, revealed-id
   monotonicity, and that final message ≠ raw question for evolved arms.
   Exact prefix string parity is soft (recorded, not required).

2. **Deterministic FakeProvider**  
   `FakeProvider.script(stage, attempt) -> raw_json` drives full
   `Generate.from_source` for one GSM8K pin. Assert construction_id stability,
   trace digests, and that admit→lock→Admit.from_lock is byte-identical.

3. **Negative ignore-history control**  
   Agent that answers using only the last user message. On an evolved arm whose
   turn-0 arguments are counterfactual and later corrected, reward must be 0
   when the last message alone is insufficient; a full-history oracle agent
   that reconstructs active values scores 1. This falsifies terminal-dump
   shortcuts.

4. **Live generation smoke (marked `@pytest.mark.live`)**  
   One GSM8K test item, real provider, `num_counterfactuals=1`,
   `num_predecessors=1`, `num_turns=3`. Assert construction traces accepted,
   final intent restored, native oracle passes on gold answer format, and
   ignore-history control fails. Not required in default CI.

5. **Domain seam contract tests**  
   Each paper domain: `load_pin` round-trip digests; `score` accepts gold /
   rejects known wrong; SWE seam refuses `recap_method='dump'` as upstream does.

### Red-flag screen (this candidate)

| Flag | Screen |
|------|--------|
| Shallow module | Callers use only Generate/Admit/Run. Stages are not public. Rejected designs that expose `extract()` to callers. |
| Information leakage | Wire JSON and HuggingFace row dicts parse behind seams into `SourceRecord` / `Construction`. Upstream raw dicts are not re-exported from `parallax.evolving`. |
| Temporal decomposition | Files are not named for pipeline order alone. `construct.py` owns generation policy; `seams.py` + `domains/*` own domain knowledge used at any time; `schedule.py` owns placement invariants. |
| Pass-through method | No `def build(...): return admit_family(...)` public wrappers. `Admit.family` *is* the policy boundary (checks + identity). Domain registry is a closed dict, not a cascading facade. |
| Vague plugin framework | Closed `Domain` enum + one seam module per member. No entry-point discovery, no `**options` stage bag. |

### Interface depth

Public surface: three classes, one enum, one provider protocol. Hidden behind
it: retry/escalation, four generation stages, plan-first scheduling, domain
prefix rendering, sealing, admission, locks, conversation/workspace runtimes,
native graders. Call chains for the happy path stay at one file for callers
(`api.py` → one owner module). Tracing an admit failure requires at most
`admit.py` → `schedule.py` / `render.py` → `state.py`.

---

## Synthesis decision

_Filled by arena. Candidate C base claim: ledger-first paper-state kernel with
closed domain enum; reject shortcut event models and plugin registries._

---

## Tradeoffs accepted

- We accept **porting** the plan-first scheduler (not calling upstream as a
  library) in exchange for typed `TurnBlueprint` invariants and a freeze
  boundary upstream does not have.
- We accept a **closed Domain enum** (PR required to add a domain) in exchange
  for refusing open plugin discovery and keeping the kernel import graph
  finite and reviewable.
- We accept **rule-based rendering only** in v1 admit in exchange for
  deterministic locked replay; LLM naturalization becomes a separate sealed
  verb later.
- We accept **exact prefix/string non-parity** with paper conversations in
  exchange for structural parity (transitions, restoration, scenario inference).
- We accept a one-release `RemovedError` stub on old `parallax.build(...,
  strategy=EvolvingIntent)` in exchange for not maintaining dual EI paths.
- We accept SWE workspace complexity inside `domains/swe_bench_verified` in
  exchange for keeping `schedule.py` domain-agnostic aside from `post_fill`.

---

## Alternatives considered

1. **Thin wrapper over upstream Python packages**  
   Call `intent_construction` and `situated_simulation` in-process, freeze
   their JSON. Hides little complexity (callers still face raw dicts, script
   CLIs, and missing identity/admission). Lost on interface depth: shallow
   facade over an untyped pipeline; Parallax sealing would still re-parse
   everything.

2. **Plugin registry of StageHandler / Renderer / Evaluator entry points**  
   Maximum extension surface. Exposes temporal stages and invites the same
   four-model conflict under new names. Lost: shallow modules, information
   leakage of stage options, vague plugin framework forbidden by the design
   goal.

3. **Keep ProposalBundle events; generate them from upstream as a compiler
   target**  
   Preserves the shortcut API. Lost: the event model cannot express
   multi-step correction chains, shared-argument deadlines, or SWE symptom
   ordering without becoming a second scheduler; terminal dump pressure
   remains.

4. **Messages-first Family (store turns, reconstruct intent by parse)**  
   Simpler artifacts. Lost: invalid states become representable; admission
   cannot prove restoration without a brittle NL parse; violates
   single-source-of-truth for intent.

---

## Open questions and risks

- Should train-mode randomness ever be admit-able into locks, or are locks
  restricted to `mode="eval"` only?
- For BIRD-SQL partial-turn gold, do we seal per-turn answers into the
  ChangePlan always, or only when scenario is under-specified?
- How large may `ProviderTrace.raw_response` grow in the construction store
  before we require external blob-by-digest references?
- Is BrowseComp+ LLM-as-judge scoring allowed to call a provider at **run**
  time, or must judge prompts/responses be pre-frozen (run-time provider
  blurs the stochastic/deterministic boundary)?
- For SWE persistent workspace, does matched-control require a fresh
  container per arm (cost) or reset-to-base-commit between arms (complexity)?

---

## Next implementation step

Land `tests/evolving/test_upstream_schedule_characterization.py` against a
vendored upstream `create_sample` and empty `parallax.evolving.state` /
`schedule.py` stubs that raise `NotImplementedError`, then implement
`schedule` until characterization passes before any provider-backed
`construct.py` work.

---

## Rationale

### Problem

The existing kernel validated the wrong artifact: a fabricated proposal that
never ran Evolving Intent's stages and that terminal-dumps the source question.
Rebuilding around the pinned Microsoft algorithm requires a hard split between
stochastic construction evidence and deterministic paper-state replay, plus
domain seams that absorb what the common scheduler must not know.

### Usage (caller's view)

Callers run `Generate` → `Admit` → `Run` (or `Admit.from_lock` → `Run`). A
custom domain adds one enum member and one seam module; it does not learn the
scheduler. Usage is the spec; types below serve it.

### Shape

A content-addressed `Construction` ledger freezes every provider trace and the
parsed function/arguments/counterfactuals/predecessors. `Admit` schedules with
a typed port of the upstream plan-first algorithm into `TurnBlueprint` +
`ChangePlan`, renders messages only as projections, and seals a three-arm
Family under `evolving-intent-family.v1`. Domains are a closed enum of seam
modules. The shortcut intent models are deleted or demoted so only the paper
state machine claims Evolving Intent compatibility.

### Synthesis decision

_Pending arena._

### Tradeoffs accepted

See list above — closed enum, ported scheduler, rule-based v1 render, structural
rather than string parity.

### Alternatives considered

Upstream-wrapper facade, open plugin registry, ProposalBundle compiler target,
and messages-first families — all lose on depth, typed restoration, or dual-path
risk.

### Open questions and risks

Train-mode locks, SQL per-turn gold sealing, trace blob size, BrowseComp judge
at run time, SWE container reset policy.

### Next implementation step

Upstream schedule characterization harness first; then typed `schedule.py`;
then FakeProvider-backed `construct.py`; then live GSM8K smoke.
