# Candidate D — Parallax on the real Evolving Intent algorithm

**One-line thesis.** There is exactly one mutable thing in this system — a provider — and exactly one artifact that ends its influence: a `SpecPack`. Everything above the pack is a retry loop over an append-only evidence ledger. Everything below it is a pure fold from typed intent state to typed message blocks. The freeze boundary is a *type*, not a phase, and the deterministic half physically cannot reach a provider because it never receives one.

Grounded on:

- upstream `microsoft/evolving-intent` @ `993d6be9597ac03854b46362ccd647eb1bfd267a` (read: `intent_extraction/core/base_extractor.py`, `dataset_impl/{gsm8k,swe_bench_verified,bird_sql,browsecomp_plus}/`, `retrospective_expansion/counterfactual/generate_counterfactuals{,_swe,_sql}.py`, `retrospective_expansion/predecessor/{generate_predecessors,pair_swe_bugs,generate_g1_swe,generate_impl_precursors_swe,function_change_planner,generate_predecessors_sql_llm}.py`, `situated_simulation/{user_intent,turn_scheduler,turn_scheduler_swe,user_simulation,naturalizer,sql_partial}.py`, `evaluation/runners/run_experiment.py`, `evaluation/common/swe_evaluator.py`, `intent_construction/scripts/*.sh`, `situated_simulation/INTERNALS.md`)
- repository `hard-repo-tasks` (`src/parallax/{evolving_intent,kernel,gsm8k,swebench,variants,ids}.py`, `tests/test_synthesis_kernel.py`, `tests/fixtures/synthesis_kernel/proposal.json`)
- correction predicate `architecture/evolving-intent-pipeline/NOTES.md`

---

## Problem

The accepted GSM8K slice proves compilation, sealing, admission, locked replay, and scalar grading over a **hand-authored** proposal fixture. It implements none of Evolving Intent. Concretely, from reading both trees side by side: there is no function/argument extraction, no argument counterfactual generation, no chained predecessor generation, no plan-first scheduler, no domain renderer, and no independence verification. `tests/fixtures/synthesis_kernel/proposal.json` carries `prompt_digest: "bbbb…"` and `raw_response_digest: "aaaa…"` — provenance fields whose type (a 64-char hex string supplied by the caller) permits fabrication. `compile_plans` appends `source.question` verbatim as the terminal turn, which deletes the paper's entire pressure: the model never has to reconstruct active arguments from history because the last message restates the problem. `replay_plan` then "verifies" restoration by checking that the goal equals the literal string `"answer_source_task"` — a sentinel that has no relationship to the source task's arguments. The `matched` control pads with a filler sentence (`"No requirements have changed…"`) that appears nowhere upstream. SWE-bench lives in a disconnected module with its own arm enum and hardcoded three-turn schedule.

Four incompatible intent models coexist: `evolving_intent.Reveal|Revise|Switch`, `variants.IntentEvent|IntentAnchor|AnchorTrajectory`, `swebench.SweBenchEpisode` arms, and `kernel.SynthesisPlan` arms. The tests are internally consistent and therefore prove nothing about the algorithm.

What makes the shape non-obvious is that three constraints pull against each other:

1. **Upstream is temporally decomposed by construction.** Five shell scripts, five JSON files, `raw: dict[str, Any]` threaded through every function, mutation-in-place across `schedule_events → fill_arguments → fill_texts → render_turns`, and a module-global `random`. Porting that structure ports the bug class.
2. **The determinism machinery in `kernel.py` is genuinely good and must survive.** Content-addressed store, atomic publish, lock with per-file digests, admission certificate, byte-identical rebuild. That is the one asset worth keeping.
3. **Generation is irreducibly stochastic and expensive**, and the correction predicate demands raw + parsed intermediates be preserved. So the seam between "costs money, nondeterministic" and "free, byte-reproducible" has to be load-bearing rather than incidental.

Constraints the design must honor, from Phase A:

- `parallax.ids.canonical_bytes` / `digest_value` / `task_id_for` are the existing canonicalization primitives; keep them unchanged and build every digest on them.
- `compiler.py`, `grading.py`, `checks.py`, `models.py`, `adapters.py` are a separate repository-to-task compiler that does not touch intent. Do not disturb them.
- Exact conversation parity with the paper is *not* required. Algorithmic-stage parity and fixture-schema compatibility *are*.

---

## Usage (caller's view)

Four verbs. Two of them can spend money; two of them are pure and offline. You can tell which is which by looking at the signature: **the deterministic verbs take no `Provider`.**

### README quickstart

```python
from pathlib import Path

from parallax import Design, forge, replay, run, seal
from parallax.domains import gsm8k
from parallax.forge import OpenAIProvider

# ── 1. Generate once. Stochastic. Writes pack.json + ledger.jsonl. ──────────
record, oracle = gsm8k.parse_line(Path("data/gsm8k_test.jsonl"), item_id="test-0")

pack = forge(
    record,
    oracle,
    domain=gsm8k.DOMAIN,
    provider=OpenAIProvider(
        model="gpt-5.1",
        fallback="gpt-5.1",           # escalation target, per upstream fallback_model
        temperature=1.0,
        reasoning_effort=None,
    ),
    recipe=gsm8k.PAPER_RECIPE,        # 4 counterfactuals/arg, 3 predecessors, 5 attempts
    out=Path("packs/gsm8k/test-0"),
)

# ── 2. Compile + seal. Pure. No provider in scope. ─────────────────────────
bundle = seal(
    pack,
    design=Design.matched(turns=6, switches=2, revisions=2, seed=42),
    store=Path("artifacts"),
)
print(bundle.bundle_id, bundle.lock_path)

# ── 3. Run. The only stage that touches the agent under test. ──────────────
verdict = await run(bundle.episode("combined"), agent=my_agent)
print(verdict.reward, verdict.outcome, len(verdict.per_turn))
```

`forge` writes two files and returns the pack:

```
packs/gsm8k/test-0/
  pack.json      canonical, sorted, newline-terminated
  ledger.jsonl   one JSON object per provider exchange, append-only
```

`seal` writes the artifact tree and the lock:

```
artifacts/<bundle_id>/
  bundle.json
  episodes/fully-specified/{public.json,sealed.json,turns.txt}
  episodes/under-specified/{public.json,sealed.json,turns.txt}
  episodes/combined/{public.json,sealed.json,turns.txt}
artifacts/<bundle_id>/bundle.lock
```

### Call site 1 — generate a batch and inspect why something failed

```python
from parallax.forge import ForgeError, OpenAIProvider, StageExhausted

provider = OpenAIProvider(model="gpt-5.1", fallback="gpt-5.1", temperature=1.0)
packs, failures = [], []

for record, oracle in gsm8k.iter_split("test", limit=200):
    try:
        packs.append(forge(record, oracle, domain=gsm8k.DOMAIN,
                           provider=provider, recipe=gsm8k.PAPER_RECIPE,
                           out=Path("packs/gsm8k") / record.item_id))
    except StageExhausted as exhausted:
        # Every attempt — including the rejected ones — is already on disk.
        failures.append(exhausted)
        print(exhausted.stage, exhausted.last_reason)
        for attempt in exhausted.attempts:
            print(" ", attempt.attempt_index, attempt.model,
                  attempt.outcome, attempt.reason[:90])

print(f"{len(packs)} packs, {len(failures)} exhausted")
```

Failures are not silent and are not lossy: `StageExhausted.attempts` is the same `tuple[Attempt, ...]` that would have been embedded in the pack, and each `Attempt.call` resolves in `ledger.jsonl`.

### Call site 2 — build from a lock, offline, in CI

```python
from parallax import replay, run
from parallax.controls import last_turn_only

bundle = replay(Path("artifacts/9f3c…/bundle.lock"), store=Path("artifacts"))
# replay() re-derives every byte and raises AdmissionError on any drift.
# It takes no provider and no network. There is nothing to disable.

full = await run(bundle.episode("combined"), agent=agent)
blind = await run(bundle.episode("combined"), agent=last_turn_only(agent))
assert full.reward >= blind.reward   # per-episode; the real gate is taskset-level
```

### Call site 3 — run all three arms and compare

```python
bundle = replay(lock, store=store)
results = {
    scenario: await run(bundle.episode(scenario), agent=agent)
    for scenario in bundle.scenarios          # ("fully-specified","under-specified","combined")
}
# Turn and output-token budgets across under-specified and combined are equal
# by construction, not by assertion: Design.matched derives the controls from
# the treatment.
assert (bundle.episode("under-specified").knobs.budget
        == bundle.episode("combined").knobs.budget)
```

### Call site 4 — a custom, non-paper domain

A team has an internal benchmark: a CLI tool `ticketctl` where each record is a config-migration request plus a checker script. They want Evolving Intent conversations over it. They write one module. They change nothing in the kernel.

```python
# mycorp/ticketctl_domain.py
from parallax.domains import (
    Archetype, ArgumentPolicy, CounterfactualRule, Domain, PromptPack,
    Runtime, Taxonomy, Voice, register,
)
from parallax.intent import Oracle, OracleKind, SourceRecord
from parallax.judge import Evaluator, Outcome, Transcript

PROMPTS = PromptPack.from_dir(Path(__file__).parent / "prompts")
#   prompts/segmentation.txt      prompts/conversational.txt
#   prompts/verification.txt      prompts/counterfactual.txt
#   prompts/predecessor.txt       prompts/similarity.txt
#   prompts/cross_turn.txt

ARCHETYPES = (
    Archetype(
        id="audit_then_migrate",
        taxonomy=Taxonomy.T3,               # Sequential Function, L2 Partial
        share_range=(2, 4),
        instruction=Path("prompts/archetype_audit_then_migrate.txt").read_text(),
    ),
    Archetype(
        id="reframe_target_env",
        taxonomy=Taxonomy.T4,               # Function Pivot, L2 Partial
        share_range=(2, 4),
        instruction=Path("prompts/archetype_reframe_target_env.txt").read_text(),
    ),
)


class TicketctlEvaluator:
    id = "ticketctl.checker.v3"

    def commitment(self, oracle: Oracle) -> dict[str, str]:
        return {"checker_sha256": oracle.payload["checker_digest"],
                "evaluator": self.id}

    def grade(self, transcript: Transcript, oracle: Oracle) -> Outcome:
        config = extract_fenced_yaml(transcript.final_text)
        if config is None:
            return Outcome.invalid("no_config_block")
        return Outcome.scored(run_checker(oracle.payload["checker"], config))


def parse(raw: Mapping[str, Any]) -> tuple[SourceRecord, Oracle]:
    return (
        SourceRecord(
            domain="ticketctl", dataset="mycorp/ticketctl", revision="2026-07",
            split=raw["split"], item_id=raw["id"], prompt=raw["request"],
            extra={"tool_version": raw["tool_version"]},
        ),
        Oracle(kind=OracleKind.PROGRAM, evaluator_id="ticketctl.checker.v3",
               payload={"checker": raw["checker"],
                        "checker_digest": sha256_of(raw["checker"])}),
    )


DOMAIN = Domain(
    name="ticketctl",
    prompts=PROMPTS,
    archetypes=ARCHETYPES,
    policy=ArgumentPolicy.all_eligible(),           # every argument may be counterfactualed
    counterfactual_rule=CounterfactualRule.VALUE_SWAP,  # strict forward reconstruction
    voice=Voice.from_toml(Path("prompts/voice.toml")),  # prefix pools + join rules
    runtime=Runtime.conversation(),
    parse=parse,
    evaluator=TicketctlEvaluator(),
    probe=None,                                     # no functional-independence probe
    chain=None,                                     # generic archetype chain builder
    overlay=None,
    per_turn_oracle=None,
)

register(DOMAIN)
```

Then the same four verbs, unchanged:

```python
import mycorp.ticketctl_domain as ticketctl

pack   = forge(record, oracle, domain=ticketctl.DOMAIN, provider=provider,
               recipe=Recipe(counterfactuals=3, predecessors=2), out=out)
bundle = seal(pack, design=Design.matched(turns=5, switches=2, revisions=1), store=store)
verdict = await run(bundle.episode("combined"), agent=agent)
```

Nine members, five of which are plain data. The domain declares *knowledge* — prompts, taxonomy, prefix pools, eligibility, evaluator. The kernel keeps *control* — retries, escalation, ledger, deadline scheduling, argument deferral, restoration, sealing. That asymmetry is what keeps this from being a plugin framework.

---

## Shape

### The two halves and the wall between them

```
                        ┌─────────── stochastic ───────────┐
  SourceRecord ──►  forge(record, oracle, domain, provider, recipe)  ──►  SpecPack
                        │  extract · counterfactual · chain │        (+ ledger.jsonl)
                        │  retries · escalation · probes    │
                        └───────────────────────────────────┘
════════════════════════════ FREEZE ════════════════════════════
                        ┌─────────── deterministic ─────────┐
  SpecPack ──►  compile_episode(pack, knobs)  ──►  Episode ──►  seal(...)  ──►  Bundle
                        │  schedule · fill · render         │              (+ bundle.lock)
                        └───────────────────────────────────┘
  bundle.lock ──►  replay(lock, store)  ──►  Bundle          (byte-identical or AdmissionError)
  Episode + agent ──►  run(...)  ──►  Verdict                (native evaluator)
```

The wall is enforced structurally, not by convention: `compile_episode`, `seal`, and `replay` have no `Provider` parameter and `parallax.intent` does not import `parallax.forge`. There is no `offline=True` flag to forget to set.

### Module map

```
src/parallax/
  __init__.py        forge, seal, replay, run, Design, Knobs  ← the whole public API
  ids.py             unchanged (canonical_bytes, digest_value, task_id_for)

  intent/            THE ALGEBRA — pure, no I/O, no provider, no domain objects
    spec.py          SourceRecord Oracle Function Argument Variant Predecessor SpecPack
    state.py         IntentState TurnDelta Trajectory Scenario TargetAnswer
    plan.py          Knobs Design Event Slot Schedule Block Turn Episode compile_episode

  forge/             THE GENERATOR — owns every provider call and every retry
    __init__.py      forge(), Recipe, ForgeError, StageExhausted
    provider.py      Provider protocol · OpenAIProvider · CassetteProvider · Escalation
    ledger.py        Ledger CallRef Attempt Provenance      ← only minter of CallRef
    stages.py        _extract _counterfactual _chain        ← private, one file
    probes.py        IndependenceProbe: MathVerify LlmJudge Bm25Rag

  domains/
    __init__.py      Domain PromptPack Archetype Voice ArgumentPolicy Runtime register
    gsm8k.py  browsecomp.py  bird_sql.py  swebench.py

  seal.py            Bundle Certificate identity admission lock store replay
  judge.py           Evaluator Outcome Verdict Transcript Agent Reply
  controls.py        last_turn_only, shuffled_history   ← negative controls
```

Tracing any flow reads at most three files. `forge → stages → provider`. `compile_episode → schedule → render` (all in `plan.py`). `run → judge`. `seal → ids`.

### Core data shapes

#### Provenance you cannot fabricate

The single largest structural change. Today a caller hands `ProposalBundle` two hex strings and a regex validates their *shape*. Instead, `CallRef` is minted only by `Ledger.record`, and no generated object is constructible without one.

```python
Digest = NewType("Digest", str)          # validated lowercase sha256, 64 chars


@dataclass(frozen=True)
class CallRef:
    """Handle to one recorded provider exchange.

    Invariant: only Ledger.record constructs this. The `_mint` token is a
    module-private sentinel; passing anything else raises. Enforced in
    __post_init__ rather than by convention, because the whole point of this
    type is that a caller cannot conjure one.
    """
    index: int
    prompt_digest: Digest
    response_digest: Digest
    _mint: object = field(repr=False)

    def __post_init__(self) -> None:
        raise NotImplementedError  # TODO: assert self._mint is ledger._MINT


class AttemptOutcome(StrEnum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"       # validator said no; reason is fed back into the next prompt
    ERROR = "error"             # transport / JSON decode / empty completion


@dataclass(frozen=True)
class Attempt:
    call: CallRef
    stage: Stage                # EXTRACT_DECOMPOSE … CHAIN_INDEPENDENCE
    model: str                  # the model actually used, post-escalation
    attempt_index: int          # 0-based, per generated object
    outcome: AttemptOutcome
    reason: str                 # "" when ACCEPTED; the validator feedback otherwise


@dataclass(frozen=True)
class Provenance:
    """Attached to every LLM-produced value. Rejected attempts are kept."""
    accepted: CallRef
    attempts: tuple[Attempt, ...]      # ordered, includes the accepted one last

    def __post_init__(self) -> None:
        raise NotImplementedError
        # TODO: attempts non-empty; exactly one ACCEPTED; it is attempts[-1];
        #       attempts[-1].call == accepted; attempt_index strictly increasing.
```

`Ledger` is append-only and content-addressed:

```python
class Ledger:
    """Append-only record of every provider exchange, on disk as JSONL.

    Idempotency: record() is keyed by (prompt_digest, call_index). Re-running
    forge against a CassetteProvider produces byte-identical ledger lines, so a
    crashed forge can be resumed without duplicating evidence.
    """

    def record(self, *, stage: Stage, model: str, request: Request,
               response: RawResponse) -> CallRef: ...

    def resolve(self, ref: CallRef) -> tuple[Request, RawResponse]: ...

    @property
    def digest(self) -> Digest:
        """sha256 over the canonical bytes of every line, in order."""
```

`SpecPack.__post_init__` walks every `Provenance` in the tree and requires that each `CallRef` resolves in the ledger whose digest it records. **The fabricated-fixture failure mode becomes a construction error.** Per `encode-lessons-in-structure`.

#### The intent algebra

Named to match the upstream formalization in `situated_simulation/user_intent.py`, so a reader with the paper open can map one to one.

```python
ArgumentId = NewType("ArgumentId", int)
FunctionId = NewType("FunctionId", int)     # 0 = source f_T; 1..g = predecessors, nearest-first


@dataclass(frozen=True)
class Variant:
    """c̃_i^(j) — one counterfactual value for one argument."""
    text: str
    swapped_from: str | None    # original_value; required when rule is VALUE_SWAP
    swapped_to: str | None      # counterfactual_value
    rationale: str
    provenance: Provenance


@dataclass(frozen=True)
class Argument:
    """c_i ∈ C — source value plus its ordered counterfactual chain.

    Invariant: variants is empty unless the domain policy marked this argument
    eligible. The correction chain the scheduler will walk is
    `variants[1:] + (text,)` — exactly upstream fill_texts(), where the LAST
    step is always the source value.
    """
    id: ArgumentId
    text: str
    category: str | None        # domain taxonomy: "symptom"|"location"|… or None
    eligible: bool
    variants: tuple[Variant, ...]
    provenance: Provenance

    def correction_chain(self) -> tuple[str, ...]:
        """[v2, v3, …, vN, source]. Single-variant → (source,)."""
        raise NotImplementedError


@dataclass(frozen=True)
class Function:
    """f — a task stated WITHOUT its arguments. Must stand alone as turn 0."""
    id: FunctionId
    text: str


@dataclass(frozen=True)
class Predecessor:
    """One backward step in the chain: f_k inferred from f_{k+1}."""
    function: Function
    shared: frozenset[ArgumentId]       # inherited from the successor
    fabricated: tuple[Argument, ...]    # own new arguments; never eligible
    archetype: str                      # e.g. "compute_then_extend"
    taxonomy: Taxonomy                  # T1|T2|T3|T4
    transition_reason: str
    transition_phrase: str | None       # SWE impl-precursor verbatim cue
    provenance: Provenance
```

#### The frozen pack

```python
class ProbeVerdict(StrEnum):
    PASSED = "passed"
    FAILED = "failed"
    SKIPPED = "skipped"          # tri-state, matching upstream's True/False/None


@dataclass(frozen=True)
class ProbeResult:
    verdict: ProbeVerdict
    passes: int
    runs: int
    detail: tuple[Mapping[str, CanonicalValue], ...]
    provenance: tuple[Provenance, ...]


@dataclass(frozen=True)
class Fingerprint:
    """Everything about HOW the pack was made, other than the exchanges."""
    upstream_revision: str          # 993d6be…, the algorithm we claim parity with
    prompt_pack_digest: Digest      # digest of the domain's prompt texts
    generator_model: str
    fallback_model: str | None
    judge_model: str
    temperature: float
    reasoning_effort: str | None
    recipe: Mapping[str, CanonicalValue]
    seed: int


@dataclass(frozen=True)
class SpecPack:
    """Frozen output of all stochastic generation.

    Everything downstream is a pure function of this value. Corresponds to
    upstream's Stage-3 output JSON (the `predecessor.json` a domain script
    produces), plus provenance the upstream format does not carry.
    """
    format: Literal["parallax.specpack.v1"]
    record: SourceRecord
    oracle: Oracle
    source: Function                        # id == 0
    arguments: tuple[Argument, ...]         # C, sorted by id, unique
    predecessors: tuple[Predecessor, ...]   # nearest-first (upstream storage order)
    independence: ProbeResult
    cross_turn: ProbeResult
    fingerprint: Fingerprint
    ledger_digest: Digest
    frozen_at: str                          # RFC3339, UTC

    def __post_init__(self) -> None:
        raise NotImplementedError
        # TODO, all raising ValueError with a specific message:
        #  1. argument ids unique, sorted, >= 1
        #  2. fabricated ids disjoint from source ids (upstream offsets 100/1000/2000)
        #  3. every Predecessor.shared ⊆ ids visible at that depth
        #  4. every Provenance.accepted resolves in the ledger at ledger_digest
        #  5. ANTI-DUMP LINT: normalized token overlap between `source.text` and
        #     `record.prompt` is below the domain's threshold, and source.text is
        #     not a substring of record.prompt. This is the type-level answer to
        #     "terminal full-question dump".
        #  6. if rule is VALUE_SWAP: every Variant has swapped_from/swapped_to and
        #     text == argument.text.replace(swapped_from, swapped_to, 1) modulo
        #     the article/apostrophe normalization upstream permits.

    @property
    def digest(self) -> Digest:
        """Covers ledger_digest, therefore transitively every provider exchange."""
```

Note invariant 5. Upstream never states it because upstream never had the failure; the repo's fixture *is* the failure. Encoding it here means the shortcut cannot be reintroduced by a future contributor without deleting a named check.

#### State, delta, trajectory

```python
class TargetAnswer(StrEnum | tagged union):
    """y_t. UNDEFINED during a function-switch mid-conversation; KNOWN at the
    terminal turn; PARTIAL for BIRD-SQL under-specified turns where sql_partial
    can compute an intermediate gold."""
    UNDEFINED = ...
    # KNOWN(text) / PARTIAL(text) carried as frozen dataclasses


@dataclass(frozen=True)
class IntentState:
    """I_t = (f_t, C_t, C_rev_t, y_t)."""
    function: FunctionId
    active: Mapping[ArgumentId, str]     # C_t — current value, source or counterfactual
    revealed: frozenset[ArgumentId]      # C_rev_t
    target: TargetAnswer                 # y_t

    @property
    def fully_specified(self) -> bool: ...
    @property
    def counterfactual_ids(self) -> frozenset[ArgumentId]: ...
    def digest(self) -> Digest: ...


class DeltaKind(StrEnum):
    FUNCTION_CHANGE = "function_change"
    ARGUMENT_CHANGE = "argument_change"
    ARGUMENT_REVEAL = "argument_reveal"


@dataclass(frozen=True)
class TurnDelta:
    """ΔI_t = I_t ⊖ I_{t-1}.

    Upstream assigns exactly one primary kind with precedence
    function_change > argument_change > argument_reveal, while still carrying
    the secondary reveals/corrections. We keep that precedence and encode the
    consistency in the type instead of leaving it to the writer.
    """
    kind: DeltaKind
    newly_revealed: tuple[ArgumentId, ...]
    corrections: tuple[Correction, ...]           # (id, before, after)
    function_from: FunctionId | None
    function_to: FunctionId | None

    def __post_init__(self) -> None:
        raise NotImplementedError
        # TODO: kind is FUNCTION_CHANGE iff function_to is not None
        #       kind is ARGUMENT_CHANGE implies corrections and no function_to
        #       kind is ARGUMENT_REVEAL implies newly_revealed and nothing else


@dataclass(frozen=True)
class Trajectory:
    """I_0 … I_T plus ΔI_1 … ΔI_T. Constructible only when intent is restored.

    Restoration replaces the `_ANCHOR_GOAL == "answer_source_task"` sentinel.
    The terminal state must equal the state the SOURCE arguments define:
      states[-1].function  == FunctionId(0)
      states[-1].revealed  == every source argument id
      states[-1].active    == {arg.id: arg.text for arg in pack.arguments}

    `restoration_digest` is the digest of that required terminal state, so the
    check survives serialization without needing the pack in scope.
    """
    states: tuple[IntentState, ...]
    deltas: tuple[TurnDelta, ...]
    scenario: Scenario
    restoration_digest: Digest

    def __post_init__(self) -> None:
        raise NotImplementedError
        # TODO: len(deltas) == len(states) - 1
        #       states[-1].digest() == restoration_digest      ← the real predicate
        #       each delta is consistent with states[i] → states[i+1]

    @classmethod
    def of(cls, pack: SpecPack, states, deltas, scenario) -> "Trajectory":
        """Computes restoration_digest from the pack and validates."""
```

`Correction` is `(ArgumentId, before: str, after: str)`. A correction whose `after` equals the source value is the chain's last step.

#### Knobs, scenario, design

```python
class Scenario(StrEnum):
    FULLY_SPECIFIED = "fully-specified"      # t=1, g=0, p=0
    UNDER_SPECIFIED = "under-specified"      # t>1, g=0, p=0
    ARGUMENT_REVISION = "argument-revision"  # p>0, g=0
    FUNCTION_SWITCH = "function-switch"      # g>0, p=0
    COMBINED = "combined"                    # g>0, p>0


class Mode(StrEnum):
    EVAL = "eval"      # deterministic selection, round-robin counterfactuals
    TRAIN = "train"    # randint(1, max) sampling, shuffled counterfactual pool


@dataclass(frozen=True)
class Budget:
    max_turns: int
    output_tokens_per_turn: int


@dataclass(frozen=True)
class Knobs:
    """Upstream's (num_switches g, num_revisions p, num_turns t, mode, seed)."""
    switches: int
    revisions: int
    turns: int
    mode: Mode
    seed: int
    output_tokens_per_turn: int
    recap: RecapMethod | None            # NONE | PROMPT | DUMP | GROUND_TRUTH

    def __post_init__(self) -> None:
        raise NotImplementedError
        # TODO: turns >= 1 + switches + revisions   (upstream min_turns)
        #       switches, revisions >= 0; seed >= 0

    @property
    def scenario(self) -> Scenario: ...
    @property
    def budget(self) -> Budget: ...


@dataclass(frozen=True)
class Design:
    """A treatment arm plus controls DERIVED from it, so budget parity is a
    property of construction rather than an admission check that can drift."""
    treatment: Knobs
    controls: tuple[Knobs, ...]

    @classmethod
    def matched(cls, *, turns: int, switches: int, revisions: int,
                mode: Mode = Mode.EVAL, seed: int = 42,
                output_tokens_per_turn: int = 256,
                recap: RecapMethod | None = None) -> "Design":
        """treatment = combined(g, p, t)
        controls   = (fully-specified(t=1), under-specified(t=t, g=0, p=0))

        The under-specified control is upstream-native: same turn budget, same
        token budget, reveals spread across turns, zero intent evolution. It
        REPLACES the repo's `matched` arm, which padded with the invented filler
        "No requirements have changed…" and had no upstream counterpart.
        """

    def all(self) -> tuple[Knobs, ...]: ...
```

#### Schedule, blocks, turn, episode

```python
class EventKind(StrEnum):
    FUNCTION_INIT = "function_init"
    FUNCTION_CHANGE = "function_change"
    CORRECTION = "correction"


@dataclass(frozen=True)
class Event:
    kind: EventKind
    function: FunctionId | None
    argument: ArgumentId | None
    step: int | None                    # index into the argument's correction chain


@dataclass(frozen=True)
class Reveal:
    argument: ArgumentId
    value: str
    counterfactual: bool


@dataclass(frozen=True)
class Slot:
    """Immutable. Upstream mutates TurnSlot across four functions; here each
    step returns a new Schedule, per separate-before-serializing-shared-state."""
    index: int
    events: tuple[Event, ...]
    reveals: tuple[Reveal, ...]


@dataclass(frozen=True)
class Schedule:
    slots: tuple[Slot, ...]
    selected: tuple[FunctionId, ...]                    # farthest-first order
    chains: Mapping[ArgumentId, tuple[str, ...]]        # correction chain per argument
```

Blocks are the reason a message cannot contain the benchmark question:

```python
@dataclass(frozen=True)
class FunctionBlock:
    function: FunctionId
    changed: bool                       # False only at turn 0 (no prefix, per upstream)

@dataclass(frozen=True)
class CorrectionBlock:
    argument: ArgumentId
    step: int

@dataclass(frozen=True)
class RevealBlock:
    arguments: tuple[ArgumentId, ...]

@dataclass(frozen=True)
class RecapBlock:
    method: RecapMethod
    state_index: int

Block = FunctionBlock | CorrectionBlock | RevealBlock | RecapBlock
```

**There is no `RawTextBlock`.** Every string a turn can contain is looked up by id in the pack: a `Function.text`, an `Argument.text`, or a `Variant.text`. The only way `record.prompt` could reach a turn is if extraction produced a `source.text` equal to it — which `SpecPack` invariant 5 rejects at construction. That is the whole terminal-dump defence, and it is one type declaration wide.

Domain preambles (BIRD schema + evidence, SWE system prompt, GSM8K answer-format instruction) are *not* blocks:

```python
@dataclass(frozen=True)
class Preamble:
    """Domain header attached once. Rendered before turn 0's blocks. Subject to
    the same leak lint against record.prompt as SpecPack invariant 5."""
    system: str | None
    turn0_prefix: str | None            # BIRD schema + evidence
    instruction_template: str | None    # "{content}" wrapper, upstream DEFAULT_INSTRUCTIONS
```

```python
@dataclass(frozen=True)
class Turn:
    index: int
    state: IntentState
    delta: TurnDelta | None             # None only at index 0
    blocks: tuple[Block, ...]

    def text(self, pack: SpecPack, voice: Voice, cursor: PrefixCursor) -> str:
        """Derived. Never stored as the source of truth. seal() hashes `blocks`,
        writes text as a convenience artifact, and admission re-renders to
        confirm byte equality — single source of truth with a verified cache."""


@dataclass(frozen=True)
class Episode:
    pack_digest: Digest
    knobs: Knobs
    scenario: Scenario
    preamble: Preamble
    trajectory: Trajectory
    turns: tuple[Turn, ...]                       # len == len(trajectory.states)
    per_turn_oracle: tuple[Oracle | None, ...]    # BIRD partial gold; None elsewhere
    _oracle: Oracle = field(repr=False)           # terminal answer authority, sealed

    def public_view(self) -> Mapping[str, CanonicalValue]:
        """Opening turn text + safe record metadata + budget + evaluator
        commitment digests. Never the oracle, never a future turn."""

    def sealed_view(self) -> Mapping[str, CanonicalValue]:
        """Blocks, trajectory, oracle payload, per-turn oracles, pack digest."""

    @property
    def episode_id(self) -> Digest:
        """task_id_for(digest(public_view()), digest(sealed_view()))"""
```

### Signatures and ownership

**`parallax/__init__.py` — the entire public API.**

```python
def forge(record: SourceRecord, oracle: Oracle, *, domain: Domain,
          provider: Provider, recipe: Recipe, out: Path) -> SpecPack:
    """Run extraction, counterfactual generation, and chained predecessor
    generation against a live provider. Writes pack.json and ledger.jsonl to
    `out`. Raises StageExhausted with the full attempt list on failure."""

def compile_episode(pack: SpecPack, knobs: Knobs, *, domain: Domain) -> Episode:
    """Pure. Schedule → fill → render. Exposed for tests and tooling; most
    callers use seal(), which compiles the whole Design."""

def seal(pack: SpecPack, *, design: Design, store: Path,
         waiver: Waiver | None = None) -> Bundle:
    """Compile every arm, run admission, publish content-addressed artifacts,
    write bundle.lock. Idempotent: re-sealing the same pack+design re-publishes
    byte-identical files or raises if the directory differs. Refuses a pack whose
    independence probe FAILED unless `waiver` is supplied."""

def replay(lock: Path, *, store: Path) -> Bundle:
    """Rebuild from the lock. Verifies pack digest, ledger digest, per-file
    digests, and bundle identity. No provider parameter exists on this path."""

async def run(episode: Episode, *, agent: Agent) -> Verdict:
    """Drive the conversation or workspace runtime, then hand the transcript to
    the domain's native evaluator."""
```

Five functions, three of them pure or offline. Everything in the "Full flow" section below happens behind them.

**`intent/plan.py` — scheduler and renderer, one owner.**

```python
def schedule(pack: SpecPack, knobs: Knobs, rng: Rng) -> Schedule:
    """Upstream turn_scheduler steps 0-2, as a pure fold.

    0. select_functions   — nearest-first storage reversed to farthest-first;
                            eval: min(g, len); train: randint(1, min(g, len))
       select_counterfactuals — prefer is_shared arguments, then any eligible;
                            eval: round-robin; train: shuffle + take p
    1. schedule_events    — deadline map (earliest function needing the source
                            value), phase buckets, post-source bucket for
                            non-shared corrections, even spread across 1..t-1,
                            final function_change pinned to t-1 unless
                            post-source corrections exist
    2. fill_arguments     — turn-0 pool with per-argument deadlines, deferral to
                            empty slots before the deadline, at least one
                            argument kept in turn 0, function-change turns take
                            their non-shared arguments, remainder distributed
    2b. redistribute + trim empty slots, with the redundancy guard (never steal
        a counterfactual reveal to a turn after its own correction)
    2c. restate stale text for reveals moved past their correction chain

    Never fails when knobs.turns >= 1 + g + p. Returns a new Schedule at every
    step; no in-place mutation, no module-global random.
    """
    raise NotImplementedError


def blocks_for(schedule: Schedule, pack: SpecPack) -> tuple[tuple[Block, ...], ...]:
    """Upstream render_turns' ordering, as types instead of strings:
    function → correction(s) → reveal(s), one tuple per slot."""
    raise NotImplementedError


def trajectory_for(schedule: Schedule, pack: SpecPack,
                   knobs: Knobs, domain: Domain) -> Trajectory:
    """Upstream build_change_plan. Walks slots, applies events and reveals,
    emits IntentState per turn and TurnDelta between. `Trajectory.of` then
    enforces terminal restoration."""
    raise NotImplementedError


def render(blocks: tuple[Block, ...], turn_index: int, pack: SpecPack,
           voice: Voice, cursor: PrefixCursor) -> str:
    """Prefix selection + join. Reads Voice (domain data) and Block (kernel
    type). Does not see the Domain object."""
    raise NotImplementedError


@dataclass(frozen=True)
class PrefixCursor:
    """Deterministic prefix rotation derived from digest(pack.digest, knobs),
    NOT from mutable counters on a long-lived loader.

    Upstream keeps self._eval_prefix_counter_* on EvolvingIntent, so a sample's
    prefixes depend on how many samples were built before it. We do not port
    that: it makes single-sample reproduction impossible. Documented divergence;
    the characterization harness compares structure, not prefix strings.
    """
    def advance(self, pool: str) -> tuple[int, "PrefixCursor"]: ...
```

**`forge/__init__.py` and `forge/stages.py`.**

```python
@dataclass(frozen=True)
class Recipe:
    counterfactuals: int = 4          # per argument
    predecessors: int = 3
    max_attempts: int = 5             # per generated object
    max_verify_attempts: int = 2      # chain-level regeneration
    independence_runs: int = 3        # majority vote
    max_independence_retries: int = 2
    share_num: int | None = None      # exact shared-argument count, or archetype default
    enable_solvability: bool = True


def forge(...) -> SpecPack:
    ledger = Ledger.open(out / "ledger.jsonl")
    extraction   = _extract(record, domain, provider, recipe, ledger)
    arguments    = _counterfactual(extraction, domain, provider, recipe, ledger)
    chain        = _chain(extraction, arguments, oracle, domain, provider, recipe, ledger)
    pack = SpecPack(...)              # __post_init__ validates everything above
    _write_canonical(out / "pack.json", pack)
    return pack


# --- private; signatures shown so the flow reads from the types ---
def _extract(record, domain, provider, recipe, ledger) -> Extraction: ...
def _counterfactual(extraction, domain, provider, recipe, ledger) -> tuple[Argument, ...]: ...
def _chain(extraction, arguments, oracle, domain, provider, recipe,
           ledger) -> tuple[tuple[Predecessor, ...], ProbeResult, ProbeResult]: ...
```

**`forge/provider.py`.**

```python
@dataclass(frozen=True)
class Request:
    messages: tuple[Message, ...]
    model: str
    temperature: float | None
    reasoning_effort: str | None
    max_tokens: int | None
    response_format: ResponseFormat        # TEXT | JSON_OBJECT


@dataclass(frozen=True)
class RawResponse:
    text: str
    items: tuple[Mapping[str, Any], ...]   # Responses-API output items, verbatim
    provider_metadata: Mapping[str, CanonicalValue]


class Provider(Protocol):
    """The ONLY interface to a model in the generation half.

    Deliberately narrow: one method. Transport concerns (Azure vs OpenAI,
    chat-completions vs responses, max_tokens vs max_completion_tokens,
    Retry-After parsing, jittered backoff, rate-limit budgets) live behind it
    and never appear in a domain, a stage, or a type — per boundary-discipline.
    """
    def complete(self, request: Request) -> RawResponse: ...


@dataclass(frozen=True)
class Escalation:
    primary: str
    fallback: str | None
    escalate_after: int           # upstream: max_attempts // 2

    def model_for(self, attempt_index: int) -> str: ...
```

`OpenAIProvider` implements upstream's `llm_utils` behavior: backend selection, deployment mapping, reasoning-model detection, `Retry-After` honouring with jitter, and encrypted-reasoning `include=` on the Responses API. `CassetteProvider` replays a committed recording keyed by `digest(request)`.

**`domains/__init__.py`.**

```python
@dataclass(frozen=True)
class Archetype:
    id: str
    taxonomy: Taxonomy            # T1 Knowledge Acquisition … T4 Function Pivot
    share_range: tuple[int, int]
    instruction: str              # the long chain-type prompt block


class CounterfactualRule(StrEnum):
    VALUE_SWAP = "value_swap"     # forward-reconstruction validated (GSM8K, BrowseComp, BIRD)
    FREEFORM = "freeform"         # distinctness only (SWE: category rewrites are not swaps)


@dataclass(frozen=True)
class ArgumentPolicy:
    categories: tuple[str, ...] | None            # None = untyped arguments
    eligible_categories: frozenset[str] | None    # SWE: {location, approach, scope, constraint}
    expected_count: int = 4

    @classmethod
    def all_eligible(cls) -> "ArgumentPolicy": ...


@dataclass(frozen=True)
class Voice:
    """Prefix pools + join rules. Pure data, loaded from TOML."""
    function_change: Mapping[str, tuple[str, ...]]     # keyed by taxonomy or category
    correction: tuple[str, ...]
    reveal_single: tuple[str, ...]
    reveal_multiple: tuple[str, ...]
    reveal_after_function: tuple[str, ...]
    new_info: tuple[str, ...]
    function_change_includes_text: bool = True         # False for SQL cue style
    join: JoinStyle = JoinStyle.SPACE


@dataclass(frozen=True)
class Domain:
    name: str
    prompts: PromptPack
    archetypes: tuple[Archetype, ...]
    policy: ArgumentPolicy
    counterfactual_rule: CounterfactualRule
    voice: Voice
    runtime: Runtime                                   # conversation() | workspace(image)
    parse: Callable[[Mapping[str, Any]], tuple[SourceRecord, Oracle]]
    evaluator: Evaluator
    probe: IndependenceProbe | None = None
    chain: ChainBuilder | None = None                  # None = generic archetype chain
    overlay: Overlay | None = None
    per_turn_oracle: Callable[[IntentState, SpecPack], Oracle | None] | None = None
    preamble: Callable[[SourceRecord, Knobs], Preamble] | None = None


def register(domain: Domain) -> None: ...
def get(name: str) -> Domain: ...
```

**`judge.py`.**

```python
class Outcome(StrEnum):
    SCORED = "scored"
    INVALID_SUBMISSION = "invalid_submission"
    HARNESS_ERROR = "harness_error"
    AGENT_ERROR = "agent_error"


class Evaluator(Protocol):
    id: str
    def commitment(self, oracle: Oracle) -> Mapping[str, str]:
        """Digests only — safe for the public payload. Contributes to bundle_id."""
    def grade(self, transcript: Transcript, oracle: Oracle) -> Grade: ...


@dataclass(frozen=True)
class Verdict:
    episode_id: Digest
    outcome: Outcome
    reward: float
    per_turn: tuple[TurnResult, ...]
    transcript: Transcript
    evaluator_id: str
    evidence: Mapping[str, CanonicalValue]     # FTP/PTP lists, executed SQL, judge text
```

### Interface depth

Public surface: 5 functions, 1 registration, and roughly a dozen exported types most callers only read. Hidden behind it: provider backend selection and rate-limit policy; per-object retry with validator feedback re-injection; mid-object model escalation; content-addressed append-only evidence; three generation stages with eleven distinct validators; majority-vote independence probing with feedback-driven argument regeneration; deadline-aware event scheduling; argument deferral and slot trimming with a redundancy guard; correction-chain construction; typed restoration; prefix rotation; canonical serialization; atomic content-addressed publication; lock verification; and native evaluation across four evaluator families including a Docker test harness.

What stays exposed: `Knobs` (the caller genuinely needs to choose g, p, t), `Design` (the experimental contrast is the caller's decision), and `Domain` (only for people adding one). Nothing else. A caller never coordinates several methods to complete one operation, and no public option names an internal stage.

### What this deliberately does not do

- **No online LLM naturalization.** Upstream's `naturalizer.py` rewrites turn text at `step()` time using an LLM. That is stochastic generation *below* the freeze line and would make replay meaningless. If naturalized turns are wanted, they must be produced during `forge` and frozen as text keyed by `(knobs_digest, block_digest)`; v1 ships rule-based rendering only.
- **No partially-implemented runtimes.** The repo currently models "not built yet" as a union member (`CheckpointPlan`, `CheckpointSequence`) that raises `NotImplementedError` at five call sites. Unimplemented capability is an unregistered domain, not a data variant.
- **No dual read path for `parallax.frozen-proposal.v1`.** Every existing artifact in that format has fabricated provenance. It is not readable by the new code, on purpose.

---

## Full flow, stage by stage

### Stage 1 — Extraction (`_extract`)

Upstream: `BaseExtractor.extract` plus the domain extractor. Input: `SourceRecord`. Output: `Extraction(function: Function, drafts: tuple[ArgumentDraft, ...], provenance)`.

```
for attempt in 0 .. recipe.max_attempts - 1:
    1a. decompose        prompts.segmentation ← record.prompt
                         → {"function": str, "arguments": [{"argument": str}, …]}
                         ledger.record(EXTRACT_DECOMPOSE, …)
        warn (not fail) if len(arguments) < 1 or > policy.expected_count + 2
    1b. conversational   prompts.conversational ← record.prompt, function, arguments
                         → {"initial_query": str, "hints": [{"hint": str, …}]}
                         ledger.record(EXTRACT_CONVERSATIONAL, …)
        SWE overrides: keep the decompose function (not initial_query) and carry
        each hint's `category` forward — this is a domain hook on PromptPack, not
        a branch in the kernel.
    1c. coverage verify  prompts.verification → {"coverage": "complete"|…}
                         ledger.record(EXTRACT_COVERAGE, …)
        fail → remember as a coverage-failed candidate, next attempt
    1d. remember as best_extracted (it passed coverage)
    1e. solvability      domain-specific, only when recipe.enable_solvability:
          GSM8K/BrowseComp: concat(function + sorted arguments) → generate →
            evaluator.grade against the oracle. Correct → pass. Wrong → compare
            against the cached original-question answer; equal → pass (information
            preserved), differ → fail.
          SWE: patch-alignment judge over function + arguments + gold patch[:3000].
            The patch is used ONLY here, never during extraction.
          BIRD: schema-grounded coverage judge.
        fail → next attempt
    accept → return
fallback 1: LLM-as-judge equivalence over best_extracted (prompts.llm_judge)
fallback 2: for each coverage-failed candidate, try solvability; first pass wins
exhausted  : raise StageExhausted(stage=EXTRACT, attempts=…, last_reason=…)
```

Retries and escalation: retries here are plain re-samples (upstream does not escalate during extraction). Model escalation is a `Recipe` capability applied uniformly by `Escalation.model_for(attempt_index)`; for extraction, `escalate_after` defaults to `max_attempts` (never), preserving upstream behavior while keeping one mechanism.

Raw evidence: every attempt — decompose, conversational, coverage, solvability, judge — is a ledger line, including the ones that failed. `Function.provenance.attempts` is the full ordered list.

Errors: JSON decode failures and transport errors become `AttemptOutcome.ERROR` lines and consume an attempt (upstream `except Exception: continue`). Exhaustion raises; the pack is never written.

### Stage 2 — Argument counterfactuals (`_counterfactual`)

Upstream: `generate_counterfactuals.py` and `generate_counterfactuals_swe.py`. Input: `Extraction`. Output: `tuple[Argument, ...]`.

```
eligible = policy.filter(drafts)                 # SWE: category ∈ {location,approach,scope,constraint}
for each eligible draft, in parallel (bounded, ≤ 20 workers):
    for j in 0 .. recipe.counterfactuals - 1:
        for dup_retry in 0 .. 2:
            for attempt in 0 .. max_attempts - 1:
                prompt = prompts.counterfactual(rule, category)
                         ← record.prompt, all arguments (context), target argument
                       + "avoid these already-generated counterfactuals: …"
                       + "your previous attempt FAILED validation: {reason}"   (if any)
                ledger.record(COUNTERFACTUAL, …)
                validate by rule:
                  VALUE_SWAP → original_value present in source; counterfactual_value
                    present in output; forward reconstruction
                    source.replace(orig, pert, 1) == output, modulo a/an and
                    apostrophe normalization; no containment either way below an
                    80% length ratio; counterfactual_value not > 2x or +10 chars
                  FREEFORM   → non-empty and != source
                reject → feed `reason` into the next attempt's prompt
            duplicate against earlier variants → retry with the duplicate added to
              the avoid list; after 2 retries, skip this j
non-eligible arguments get variants=()
zero variants across the entire record → raise StageExhausted(stage=COUNTERFACTUAL)
```

The validator feedback loop is the interesting part and is faithfully preserved: rejection reasons are prompt input, not just log output. `Variant.provenance.attempts` records each rejection with its reason, so a reviewer can read *why* the model needed four tries.

### Stage 3 — Predecessor chain (`_chain`)

Upstream: `generate_predecessors.py`, or a domain `ChainBuilder`. Input: extraction + arguments + oracle. Output: predecessors (nearest-first) + two `ProbeResult`s.

```
answer_keywords = keywords(oracle) minus stop words, len >= 4

for verify_attempt in 0 .. max_verify_attempts - 1:
    # ---- backward generation, reverse-chronological ----
    current_function, current_arguments = source, arguments
    for k in 0 .. recipe.predecessors - 1:
        archetype = rng.choice(domain.archetypes)
        for attempt in 0 .. max_attempts - 1:
            model = escalation.model_for(attempt)      # switches at max_attempts // 2
            prompt = prompts.predecessor
                     ← NEXT_GOAL, NEXT_CONDITIONS, AVOID_GOALS (every function so
                       far), SHARE_NUM_INSTRUCTION, CHAIN_TYPE_INSTRUCTION,
                       FUTURE_CHAIN (ordered successors + entity types already used)
            ledger.record(CHAIN_PREDECESSOR, …)
            validate, each rejection feeding the next attempt:
              non-empty predecessor_function
              not an exact duplicate of any function in the chain
              LLM-judge similarity vs every function in the chain → DIFFERENT
                (fallback on judge failure: word-overlap > 0.6 heuristic)
              no dangling reference ("this author", "the same film", …)
              entity_sought not already used in the chain
              <= 35 words
              no answer-keyword leakage (>= 2 distinctive keywords) in the
                function or in any fabricated argument
            assemble: shared = relevant_argument_ids ∩ successor ids, clipped or
              padded to share_num; fabricated get fresh ids at max_id + 100 + i
        no result → break (a SHORT CHAIN IS ACCEPTED, matching upstream)
        advance: current_function ← predecessor; current_arguments ← its full set

    reverse to chronological order
    # ---- chain-level cross-turn relevance ----
    for each turn: does any OTHER turn's fabricated argument leak information
      relevant to this turn's function?  prompts.cross_turn, judge model
    also check every fabricated argument against the FINAL source function
    ledger.record(CHAIN_CROSS_TURN, …)
    pass → break; else regenerate the whole chain

# ---- functional independence: g(C ∪ C_new) == g(C) ----
if domain.probe is not None and fabricated arguments exist:
    for indep_attempt in 0 .. max_independence_retries:
        for run in 0 .. independence_runs - 1:
            answer_a = probe(source_function + source arguments)
            answer_b = probe(source_function + source arguments + all fabricated)
            pass this run if answers_match(a, b) OR correct(b)
        majority (runs // 2 + 1) → PASSED
        else: regenerate every predecessor's fabricated arguments with explicit
              feedback (the wrong answers, the ground truth, the old arguments,
              why they must be independent), re-collect, retry
    ledger.record(CHAIN_INDEPENDENCE, …) for every probe call
```

Probes are domain data, not kernel branches:

| Probe | Domain | Mechanism |
|---|---|---|
| `MathVerify` | GSM8K | two generations, numeric extraction, exact match after normalization |
| `Bm25Rag` | BrowseComp+ | BM25 top-5 over the pinned corpus retrieved **once** from the base query, then A/B answers over identical documents, then an LLM equivalence judge |
| `LlmJudge` | generic | equivalence judge only |
| `None` | SWE, BIRD | no meaningful "same answer" test; verdict is `SKIPPED` |

Tri-state is preserved. `seal()` refuses a `FAILED` pack unless a `Waiver` is passed; `SKIPPED` is allowed and recorded in the certificate. This is stricter than upstream, which writes `independence_passed: false` into the dataset and proceeds — a deliberate divergence, called out in the certificate.

### Compile (pure) — `compile_episode`

```
rng      = Rng(seed=digest(pack.digest, knobs))          # no global random
pack'    = overlay.before_schedule(pack, knobs) if overlay else pack
                                                          # SWE strips symptom args
schedule = schedule(pack', knobs, rng)                    # steps 0-2c
schedule = overlay.after_fill(schedule, pack') if overlay else schedule
                                                          # SWE re-injects symptoms
                                                          # at index 0 of each slot
blocks   = blocks_for(schedule, pack')
traj     = trajectory_for(schedule, pack', knobs, domain) # Trajectory.of enforces restoration
turns    = tuple(Turn(i, traj.states[i], delta_or_none, blocks[i]) …)
oracles  = per-turn gold via domain.per_turn_oracle, else None
Episode(...)
```

Overlay contract: it may reorder and re-place reveals; it may not invent values. In `Mode.EVAL`, `compile_episode` asserts multiset equality of `(argument_id, value)` before and after `after_fill`.

Idempotence: `compile_episode` is a pure function of `(pack, knobs, domain)`. Running it twice returns equal values; running `seal` twice republishes identical bytes or raises. Crashing halfway through `seal` leaves the temp directory behind and the content-addressed target absent, because publication is a single `os.replace` — the existing `kernel._publish_artifacts` behavior, kept.

### Seal and admission

`bundle_id = digest({admission_policy, design, episode_ids, evaluator_commitment, pack_digest, record_digest})`, and `pack_digest` covers `ledger_digest`, so **the bundle identity transitively commits to every provider exchange, including the rejected ones.** Change one retry and the bundle id changes.

Admission checks (each a named `Check(name, passed, evidence)` in the certificate):

| Check | What it proves |
|---|---|
| `provenance_resolves` | every `CallRef` in the pack resolves in the ledger at `ledger_digest` |
| `terminal_restoration` | `trajectory.states[-1].digest() == restoration_digest`, per arm |
| `no_source_dump` | no turn's rendered text overlaps `record.prompt` beyond the domain threshold; the preamble passes the same lint |
| `terminal_insufficiency` | the final turn's blocks alone do not reveal or correct every argument — the deterministic proxy for history dependence |
| `budget_parity` | derived from `Design`, so this only re-confirms construction |
| `render_is_derived` | re-rendering `blocks` reproduces `turns.txt` byte for byte |
| `public_leakage` | public payload has exactly the safe key set, names no sealed field, contains no future turn |
| `oracle_success` | the sealed answer authority passes the native evaluator |
| `wrong_answer_failure` | a constructed wrong answer scores zero |
| `independence_not_failed` | probe verdict is `PASSED` or `SKIPPED`, or a waiver is attached |
| `deterministic_rebuild` | an independent compile from the same pack renders identical bytes |
| `chain_length` | `len(predecessors) >= knobs.switches`, else the arm is not buildable |

`replay(lock, store)` reruns all of them plus the per-file digest comparison.

---

## Domain adapter contract, and what cannot be generalized

### The contract

Nine members: five data (`prompts`, `archetypes`, `policy`, `counterfactual_rule`, `voice`), one enum-like (`runtime`), three callables (`parse`, `evaluator`, `preamble`). Four optional escape hatches (`probe`, `chain`, `overlay`, `per_turn_oracle`), each `None` by default.

`parse` is the boundary: raw JSON goes in, `(SourceRecord, Oracle)` comes out. Past that point no dict-shaped benchmark data exists anywhere in the system, per `boundary-discipline`. Nothing in `intent/` imports `domains/`.

### What genuinely cannot be generalized

Being explicit here matters more than pretending the seam is universal.

1. **SWE-bench predecessor construction cannot use the archetype chain at all.** The Docker image is pinned to one instance's `base_commit` and test set, so a predecessor cannot be an arbitrary invented task. Upstream builds it in three domain-owned stages: `pair_swe_bugs.py` finds a same-repo instance by a repo→area→folder cascade (argument ids offset +1000), `generate_g1_swe.py` prepends an orientation question drawn from seven fixed archetypes, and `generate_impl_precursors_swe.py` *replaces* the paired bug with an LLM-authored implementation-planning request (ids offset +2000) carrying a verbatim `transition_phrase`. This is control flow, not data. Seam: `ChainBuilder`, a protocol with one method `build(extraction, arguments, oracle, provider, ledger) -> tuple[Predecessor, ...]`, whose default is `GenericArchetypeChain(archetypes)`. SWE ships `SweBenchChain`. Honest cost: two domains own their chain logic.

2. **BIRD-SQL predecessor construction is clause-plan driven, not archetype driven.** `function_change_planner.py` deterministically enumerates `(change_set, preserve_set)` over `{SELECT, GROUP_BY, ORDER_BY, JOIN}` while `{WHERE, HAVING, LIMIT, FROM}` stay byte-identical; an LLM executes each plan; six validators run (parse round-trip, byte-identical preservation, meaningful change per clause, DB execution, different result set, dedup); then a naturalizer turns SQL into follow-up prose. Same `ChainBuilder` seam.

3. **BIRD-SQL per-turn gold answers need AST surgery plus live DB execution.** `sql_partial.py` strips WHERE predicates for unrevealed arguments, prunes now-unused joins, rebuilds, and executes. It cannot be a value; it is `Domain.per_turn_oracle(state, pack) -> Oracle | None`, `None` for every other domain.

4. **BrowseComp+ independence needs an external corpus.** BM25 over `Tevatron/browsecomp-plus-corpus`. `IndependenceProbe` is a protocol with three implementations plus `None`.

5. **Counterfactual validity is not a knob, it is a rule.** GSM8K/BrowseComp/BIRD counterfactuals are single find-and-replace value swaps and are validated by forward reconstruction. SWE counterfactuals are category-specific rewrites (constraint/scope/approach/location) that are deliberately *not* clean swaps and are validated only for distinctness. A two-member union, not a boolean.

6. **Answer normalization is entirely domain-owned.** GSM8K numeric extraction with a regex cascade; BrowseComp LLM judge; BIRD execution-set equality against SQLite; SWE patch extraction (a four-rule priority cascade) plus FAIL_TO_PASS / PASS_TO_PASS in a pinned harness image. Nothing shared but the `Evaluator` protocol.

7. **SWE turn ordering.** Symptom-category arguments must appear immediately after the function within a turn, per function phase, never crossing phases. Expressed through `Overlay` — the single scheduling escape hatch, mirroring upstream's `post_fill_hook`.

8. **Recap methods interact with overlays.** Upstream raises `NotImplementedError` for `recap_method="dump"` under the SWE overlay because the recap is computed before symptoms are injected. We keep the refusal, as a `Knobs.__post_init__` check against `domain.overlay`, so it fails at construction rather than producing wrong text.

Everything else — extraction control flow, counterfactual retry policy, deadline scheduling, argument deferral, correction chains, restoration, rendering order, prefix rotation, sealing, admission, replay — is common kernel and identical across all five domains.

---

## Scheduler and renderer ownership

Both live in `intent/plan.py`. They are one module because they protect one decision: **the correspondence between typed intent state and delivered text.** Splitting "schedule" from "render" into separate modules would be textbook temporal decomposition — two boundaries repeating the same slot representation and its invariants.

What the scheduler owns: function selection (farthest-first), counterfactual selection (shared-preferred, round-robin in eval, shuffled in train), deadline computation, event placement across turns, argument deferral, slot trimming with the redundancy guard, stale-text restatement, and correction chains.

What the renderer owns: block ordering within a turn (function → correction → reveal), prefix category choice, prefix rotation, and joining.

Two rules make "messages derive from typed state" structural rather than aspirational:

1. **A message is a function of `(blocks, pack, voice, cursor)` and nothing else.** `Turn` stores blocks; `Turn.text()` computes the string. `seal` hashes blocks; `turns.txt` is a cache; admission re-renders and compares bytes.
2. **No block can carry free text.** The four block types carry ids and indices. Every string comes from `Function.text`, `Argument.text`, or `Variant.text` in the pack. There is no path from `record.prompt` to a turn.

Two deliberate divergences from upstream, both tested:

- **No mutable prefix counters.** Upstream stores `_eval_prefix_counter_*` on the loader, so a sample's prefixes depend on how many samples preceded it. We derive `PrefixCursor` from `digest(pack.digest, knobs)`, which is order-independent and lets a single episode be reproduced in isolation.
- **No in-place slot mutation and no module-global `random`.** Each scheduling step returns a new `Schedule`; `Rng` is a value threaded through. Two concurrent compiles of different packs cannot interfere, per `separate-before-serializing-shared-state`.

---

## Native evaluator boundary and identity commitment

The evaluator sees `(Transcript, Oracle)`. It never sees the pack, the trajectory, the schedule, or the knobs. Conversely, `intent/` never imports `judge/`. The `Episode` holds the oracle privately; `public_view()` excludes it and the `public_leakage` admission check enforces that by name and by value.

Two runtimes, both fully implemented or the domain is not registered:

- `Runtime.conversation()` — `run` builds the transcript turn by turn, appending the agent's `Reply.items` verbatim so encrypted reasoning survives across turns. (The current repo's `ModelCallback -> str` silently drops those items, which changes multi-turn behavior against reasoning models; `Reply` carrying `items` is the fix.)
- `Runtime.workspace(image)` — `run` delivers the same turns, then hands the final response to the SWE evaluator, which extracts a patch through the four-rule cascade and invokes the pinned harness. A response with no extractable patch is a clean `INVALID_SUBMISSION`; the harness is never invoked.

**Identity commitment.** `Evaluator.commitment(oracle)` returns digests only and is folded into `bundle_id`:

- GSM8K → `{evaluator: "gsm8k.native.v1", answer_digest, normalizer_digest}`
- BIRD → `{evaluator, gold_sql_digest, db_snapshot_digest, comparison: "execution_set"}`
- BrowseComp → `{evaluator, answer_digest, judge_model, judge_prompt_digest}`
- SWE → `{evaluator, harness_revision, image_digest, test_patch_digest, ftp_digest, ptp_digest}`

Changing the harness image, the SQL snapshot, the judge prompt, or the answer normalizer changes the bundle id. Two bundles with the same id were graded by provably the same authority. The oracle *plaintext* appears only in `sealed.json`.

---

## Migration plan

Eight commits. Each one deletes. No permanent dual path; the two API-visible commits (3 and 4) ship together.

| # | Do | Delete |
|---|---|---|
| 1 | Add `intent/spec.py`, `intent/state.py`, `intent/plan.py` with real bodies. Land the upstream characterization harness first (see below) using hand-built `SpecPack`s converted from committed upstream Stage-3 fixtures. No public API change yet. | — |
| 2 | Add `forge/`, `domains/`, `judge.py`, `controls.py`. Record cassettes from one live GSM8K run; commit them. `forge` is exercised only through `CassetteProvider` in CI. | — |
| 3 | Port `kernel.py` → `seal.py`: identity, admission, lock, store, atomic publish, `replay`. Rewrite the payloads around `SpecPack` and `Episode`. | `RenderedTask`, `SynthesisPlan`, `StaticPlan`, `IntentPlan`, `CheckpointPlan`, `ConversationRun`, `WorkspaceEpisode`, `CheckpointSequence`, `RuntimeSpec`, `runtime_for`, `build`, `build_experiment`, `ModelCallback` |
| 4 | Repoint `__init__.py` to `forge/seal/replay/run/Design/Knobs`. Repoint `cli.py` to the same four verbs. | **`src/parallax/evolving_intent.py` in full** — `Reveal`, `Revise`, `Switch`, `ProposalBundle`, `EvolvingIntent`, `PlanArm`, `compile_plans`, `replay_plan`, `replay_events`, `_matched_turns`, `_ANCHOR_GOAL`. `tests/fixtures/synthesis_kernel/proposal.json` and `experiment.toml`. The `parallax.frozen-proposal.v1` and `parallax.family.v1` formats. |
| 5 | Move `SweBenchSource`/`SweBenchVerifier` into `domains/swebench.py` as the record and oracle. Implement `SweBenchChain` and the symptom `Overlay`. | `swebench.compile_swebench_arms`, `SweBenchIntentArm`, `SweBenchEpisode`, `generator_version = "swebench-evolving-intent-v1"` |
| 6 | Have `variants.py` import `IntentState`/`TurnDelta` from `intent.state` if it needs them. | `variants.IntentEventKind`, `IntentEvent`, `IntentSlot`, `IntentAnchor`, `AnchorTrajectory`, `CompiledTrajectory`, `compile_anchor_trajectory` — the second duplicate intent model. Keep `TaskSpec`/`VariantBlueprint`/`admit_variant`, which are a different concern. |
| 7 | Fold `gsm8k.py` into `domains/gsm8k.py`. Align `parse_final_answer` to upstream's two-pattern cascade (```` ```answer ```` fence, then `####`) and move the extra patterns behind an explicit, separately tested `lenient=True` used only by the solvability probe. | `parallax.Gsm8k`, `parallax.SourceTask` from the public API; the bare "last number anywhere" fallback from the graded path |
| 8 | Delete the tests that prove self-consistency; port only the ones that prove a property. | `test_synthesis_kernel.py` tests keyed to the proposal fixture; `test_swebench_adapter.py` arm-shape tests; `test_episode_spine.py` assertions on `SynthesisPlan` |

Four intent models become one: `IntentState` + `TurnDelta` + `Trajectory` in `intent/state.py`.

False compatibility claims to remove explicitly: the `upstream_revision: "993d6be…"` field on a proposal that implements none of that revision; `generator_version: "swebench-evolving-intent-v1"`; and the class name `EvolvingIntent`, which currently collides with upstream's data-loader class while doing something unrelated. The replacement claim is `Fingerprint.upstream_revision` alongside a `ParityRecord` written by the characterization harness — a claim backed by a test digest rather than a string literal.

---

## Verification harness (designed before implementation)

Four layers. Layer 1 lands **before** any implementation code, because scheduling parity is the highest-risk surface and it needs no provider.

### Layer 1 — Upstream characterization

`tests/upstream/` holds a pinned checkout of `993d6be` (as a git submodule or vendored tree; the repo commits only the diff, per the workspace convention) and a small set of committed Stage-3 fixtures, one per domain, taken from real pipeline output rather than authored by hand.

```python
# tests/upstream/test_scheduler_parity.py
MATRIX = [(g, p, t, mode, domain)
          for g in (0, 1, 2, 3) for p in (0, 1, 2, 4)
          for t in range(1 + g + p, 1 + g + p + 3)
          for mode in ("eval",)                      # train is RNG-divergent by design
          for domain in ("math", "search", "sql", "swe_bench_verified")]

@pytest.mark.parametrize("g,p,t,mode,domain", MATRIX)
def test_slot_structure_matches_upstream(g, p, t, mode, domain, upstream, fixture):
    theirs = upstream.turn_scheduler.create_sample(fixture.raw, g=g, p=p, t=t,
                                                   mode=mode, domain=domain, **STUB_PREFIXES)
    ours = compile_episode(fixture.pack, Knobs(g, p, t, Mode.EVAL, seed=42, ...),
                           domain=DOMAINS[domain])
    assert structure_of(ours) == structure_of_upstream(theirs)
```

`structure_of` compares, per turn: the ordered event kinds and their function/argument/step ids; the ordered reveal `(argument_id, value, is_counterfactual)` triples; and the derived `change_plan` (function per turn, revealed set per turn, active values per turn, transition kind per turn). It deliberately does **not** compare prefix strings or joined prose, because the prefix-cursor divergence is intentional and documented.

Golden files are regenerated by `pytest --update-upstream-golden`, and the regeneration diff is reviewed. This test is falsifiable and it fails loudly if our deadline map, farthest-first ordering, deferral rule, redundancy guard, or restoration turn differs from upstream by a single slot.

A companion `test_specpack_roundtrip.py` proves fixture compatibility in both directions: an upstream Stage-3 JSON converts to a `SpecPack` (minus provenance, which upstream does not carry, filled with an explicit `Provenance.imported(source_file_digest)` marker), and a `SpecPack` serializes back to a dict that upstream's `create_sample` accepts unchanged.

### Layer 2 — Deterministic fake provider

```python
class CassetteProvider:
    """Replays a committed recording keyed by digest(request).

    Strict by default: an unrecorded request raises CassetteMiss with the
    request digest and a rendered diff against the nearest recorded prompt, so
    a prompt-template edit fails visibly instead of silently re-recording.
    """
    def __init__(self, path: Path, *, strict: bool = True): ...
```

Cassettes live in `tests/cassettes/<domain>/<item_id>.jsonl`, recorded once from a real run and committed (they are small: prompt digest, model, response text). The whole of `forge` is then exercised end to end in CI with real prompt shapes, zero network, and byte-stable output.

A `ScriptedProvider` drives every error path deterministically:

| Scenario | Asserts |
|---|---|
| invalid JSON on attempt 0 | `AttemptOutcome.ERROR` recorded, attempt consumed, retry proceeds |
| coverage fails 5× | LLM-judge fallback runs; on judge failure, the solvability third pass runs |
| forward reconstruction fails | rejection reason appears verbatim in the next prompt |
| duplicate counterfactual ×3 | that variant slot is skipped, others still produced |
| similarity judge says SIMILAR | predecessor retried; after `max_attempts // 2`, model is the fallback |
| answer keywords leak | rejection, and the leaked keywords are in `Attempt.reason` |
| cross-turn relevance fails | the whole chain regenerates; the second chain is a distinct ledger slice |
| independence 1/3 | feedback regeneration runs; second probe recorded; verdict `FAILED`; `seal` raises without a waiver |
| all attempts exhausted | `StageExhausted` with the ordered attempt list; **no pack.json written** |

Plus a `Provenance` fuzzer: mutate any digest in a `pack.json` and assert `SpecPack` construction fails with `provenance_resolves`. That is the direct regression test for the fabricated fixture.

### Layer 3 — Negative ignore-history control

Two tiers.

*Build-time, deterministic, an admission check:* `terminal_insufficiency`. The final turn's blocks alone must not reveal or correct every argument. On the current fixture — whose terminal turn is the entire source question — this fails, which is the point.

*Taskset-level, empirical, run offline and committed:* `parallax.controls.last_turn_only(agent)` wraps an agent so it receives only the preamble and the final user turn.

```python
# tests/controls/test_history_dependence.py  (marked slow, cassette-backed)
def test_history_is_required(calibration_bundles, reference_agent):
    full  = mean(run(b.episode("combined"), agent=reference_agent) for b in calibration_bundles)
    blind = mean(run(b.episode("combined"),
                     agent=last_turn_only(reference_agent)) for b in calibration_bundles)
    assert full - blind >= HISTORY_DEPENDENCE_FLOOR      # committed, per domain
```

The margin is written into `ParityRecord` and shipped alongside the taskset. A taskset whose blind arm matches its full arm is invalid, no matter how clean its digests are. A second control, `shuffled_history`, checks that turn *order* matters — catching tasksets where history is present but ordering is irrelevant.

### Layer 4 — Live generation smoke test

```python
@pytest.mark.live      # deselected by default; nightly CI only, needs credentials
def test_live_forge_produces_admissible_bundle(tmp_path):
    record, oracle = gsm8k.parse_line(LIVE_RECORD, item_id="test-0")
    pack = forge(record, oracle, domain=gsm8k.DOMAIN,
                 provider=OpenAIProvider(model=LIVE_MODEL, fallback=LIVE_MODEL,
                                         temperature=1.0),
                 recipe=Recipe(counterfactuals=2, predecessors=2), out=tmp_path)

    assert pack.predecessors and any(a.variants for a in pack.arguments)
    assert pack.independence.verdict in (ProbeVerdict.PASSED, ProbeVerdict.SKIPPED)
    assert all(Ledger.open(tmp_path / "ledger.jsonl").resolve(p.provenance.accepted)
               for p in pack.predecessors)

    bundle = seal(pack, design=Design.matched(turns=5, switches=2, revisions=1),
                  store=tmp_path / "artifacts")
    assert bundle.certificate.admitted
    assert replay(bundle.lock_path, store=tmp_path / "artifacts").bundle_id == bundle.bundle_id
```

It also *records a new cassette* and diffs it against the committed one. Drift means the provider changed behavior, which is exactly what a nightly job should surface.

### Supporting checks

- **Leak lint**: assert `record.prompt` and every sealed oracle value are absent from every `public.json` and every rendered turn.
- **Determinism**: `compile_episode` twice → equal; `seal` twice → identical bytes; `seal` after a simulated mid-publish crash → identical bytes.
- **Property test**: for random `(g, p, t)` with `t >= 1 + g + p`, scheduling never returns fewer than `1 + g + p` slots, every counterfactual reveal precedes its first correction, every correction chain ends on the source value, and the terminal state equals the restoration target.

---

## Red-flag screening

Screened against `references/design-red-flags.md`.

**Shallow module.** Every module was checked for the capability/surface ratio.
- `Provider` — one method, hides two backends, two API surfaces, token-parameter dispatch, `Retry-After` parsing with jitter, encrypted-reasoning continuity. Deep.
- `Ledger` — two methods plus a digest property, hides content addressing, append-only durability, resumption, and the mint invariant. Deep.
- `Domain` — nine members. This is the one at risk. Mitigation, stated as a rule: a domain that needs a tenth capability puts it in `Overlay` or `ChainBuilder`; if a *second* domain needs the same thing, it becomes a typed kernel field and the hatch closes. Written into the module docstring so the next contributor sees the rule before adding a method.
- `intent/plan.py` — three public functions, hides the entire scheduler. Deep.
- `seal.py` — three functions, hides identity, twelve admission checks, atomic publication, lock verification. Deep.

**Information leakage.** OpenAI/Azure SDK types stop at `provider.py`; `Request`/`RawResponse` are domain types. Raw benchmark dicts stop at `Domain.parse`. The on-disk store layout is private to `seal.py` — callers get a `Bundle`, never a path convention. Canonicalization has one implementation (`ids.canonical_bytes`) used by everything. The one representation crossing module boundaries is `SpecPack`, and it has exactly one owner.

**Temporal decomposition.** The biggest risk here, because upstream *is* temporally decomposed: five scripts, five JSON files on disk, `raw: dict` everywhere. Two deliberate collapses:
- extraction, counterfactual generation, and chain generation live in `forge/stages.py` because all three protect the same decision — *what makes a legal, non-leaking, independence-verified intent spec*. They share one ledger, one retry vocabulary, one escalation policy, one error type.
- scheduling and rendering live in `intent/plan.py` because both protect the trajectory↔message correspondence.

The remaining split — `forge` vs `intent` vs `seal` vs `judge` — is by *knowledge owned*, not by execution order: the generator owns provider policy, the algebra owns intent legality, the sealer owns identity, the judge owns grading. Each would still be a separate module if the pipeline ran in a different order.

**Pass-through methods.** Checked each candidate. `seal` is not a pass-through to the store: it compiles the design, runs admission, and mints identity. `run` is not a pass-through to the evaluator: it owns transcript construction, reasoning-item continuity, turn advancement, and runtime dispatch. `compile_episode` is not a pass-through to `schedule`: it applies the overlay, builds blocks, builds the trajectory, and enforces restoration. `Ledger.resolve` forwards to a file read but adds the digest check that makes the read meaningful. No forwarding-only method survives in the sketch.

**Additional smells screened.** No boolean mode flags on the public surface (the offline/online split is a signature difference). No `Any` in the intent algebra. No optional field that is always set in practice — `Provenance` is required, not `| None`. No union member that raises `NotImplementedError` everywhere.

---

## Tradeoffs accepted

- **We accept that the domain layer owns chain-building for SWE and BIRD, in exchange for not pretending an archetype list generalizes.** A `ChainBuilder` protocol with a generic default is honest; forcing SWE's three-stage same-repo pairing into a taxonomy field would be a fiction that breaks on the first new domain.
- **We accept losing the `matched` arm's exact current behavior, in exchange for an upstream-native control.** The filler sentence "No requirements have changed…" appears nowhere in `993d6be`. `under-specified` gives the same turn and token budget with zero intent evolution and is what the paper actually contrasts against.
- **We accept that a `SpecPack` cannot be hand-authored, in exchange for provenance that cannot be fabricated.** Fixtures must be recorded or converted from upstream output, never typed by a human. That is slower and it is the point.
- **We accept a documented divergence in prefix rotation, in exchange for order-independent reproduction.** Upstream's mutable counters make a single sample irreproducible in isolation. The characterization harness compares structure, so parity remains testable.
- **We accept that online naturalization is out of scope, in exchange for a meaningful replay guarantee.** Stochastic text generation below the freeze line would make the lock a lie.
- **We accept refusing packs whose independence probe FAILED, where upstream ships them, in exchange for a stronger admission gate.** A `Waiver` keeps the door open for deliberate research use and records who opened it.
- **We accept committing cassettes to the repository, in exchange for a full-pipeline test that costs nothing per run.** They are small, and drift is caught by the nightly live test.
- **We accept a hard break of `parallax.frozen-proposal.v1`, in exchange for no dual path.** Every artifact in that format has placeholder digests; migrating them would migrate the defect.

---

## Alternatives considered

**A. Port upstream's file-per-stage pipeline directly.** Five modules mirroring the five scripts, JSON on disk between each. Interface depth: shallow and wide — callers must know the stage sequence, the file naming, and each stage's schema, so learning the interface does not save learning the implementation. Complexity exposed: stage ordering, resumption, schema drift across five boundaries. Complexity hidden: almost none. It also reproduces the exact defect we are fixing: intermediate files with no binding provenance, which is how the fabricated fixture got in. Rejected as textbook temporal decomposition.

**B. One `Pipeline` object with a fluent, configurable stage list.** `Pipeline().extract(...).counterfactual(...).predecessors(...).schedule(...).run()`. This is the "vague plugin framework" attractor. Interface depth: the public surface grows with every stage option, and each option names an internal stage — a red flag by definition. It also makes the freeze boundary a runtime property (a flag on the pipeline) rather than a type, which is the single thing this design most needs to get right. Rejected.

**C. Keep `ProposalBundle` as the frozen artifact and grow it.** Add extraction, counterfactual, and predecessor fields to the existing type; keep `compile_plans`. Interface depth: unchanged surface, so superficially attractive. But `ProposalBundle` bakes in the wrong algebra — flat `Reveal|Revise|Switch` events carrying pre-rendered `message` strings. Pre-rendered message strings *are* the terminal-dump bug: if the message is the source of truth, nothing prevents it from containing the whole question. There is no incremental path from "event carries a string" to "message derives from typed state." Rejected; this is the `redesign-from-first-principles` case.

**D. Make `IntentState` mutable and let the scheduler mutate it in place, as upstream does.** Simpler to write and a closer line-by-line port. But it forces every consumer to know when a state is finished being mutated, makes concurrent compiles unsafe, and makes `Trajectory`'s restoration invariant uncheckable at construction. Rejected per `separate-before-serializing-shared-state`; the immutable fold costs a few allocations per turn and buys a type-level guarantee.

**E. Put the evaluator inside `Episode` as a callable field.** Fewer moving parts and one less protocol. But it lets the evaluator see the trajectory, which is exactly the coupling that makes grading unfalsifiable — an evaluator with the intent spec in scope can grade against the plan instead of against the benchmark. Rejected; the `(Transcript, Oracle)` boundary is load-bearing.

---

## Open questions and risks

1. **How faithful must scheduler parity be — slot structure, or rendered text?** The harness above compares slot structure and the derived change plan, and deliberately excludes prefix strings because of the cursor divergence. If exact rendered-text parity is required, we must port the mutable prefix counters and give up single-episode reproduction. Which do you want?
2. **Should `seal` refuse a pack whose independence probe FAILED?** Upstream ships those samples with `independence_passed: false`. The design refuses them absent a `Waiver`. Is that too strict for exploratory runs, or exactly the gate the correction predicate asks for?
3. **Where do cassettes live and who regenerates them?** They are the backbone of Layer 2, they will grow with every prompt edit, and a stale cassette silently tests an old prompt. Committed in-repo with a nightly drift check, or an external fixture store?
4. **What is the `no_source_dump` overlap threshold, per domain?** GSM8K functions are short and share vocabulary with the question; SWE functions legitimately quote symbol names from the issue. A single normalized-token-overlap number will not fit all four. Should the threshold be a `Domain` field with a defended default, and if so what evidence sets it?
5. **Is `train` mode in scope for v1?** It doubles the RNG surface, is not characterization-testable against upstream (both sides sample), and no current experiment needs it. Ship `eval` only and add `train` when a training run actually needs it?
6. **How is BrowseComp+ corpus access provisioned in CI?** The independence probe needs a BM25 index over an external HuggingFace corpus. That is a heavyweight dependency for a test environment. Cache a pinned slice, or mark BrowseComp forge tests live-only?
7. **Does the SWE workspace runtime belong in `run`, or in a separate `run_workspace`?** Keeping one `run` is a smaller surface, but Docker orchestration inside the same function as a chat loop is a real complexity difference. One verb with two runtimes, or two verbs?
8. **Risk: the 251-instance SWE pool is a curated subset.** `pair_swe_bugs` needs same-repo neighbours; a small or repo-skewed pool drops instances at the "no function-switch scenario" branch. We should measure the drop rate on our pool before committing to `switches=2` for SWE.
9. **Risk: cost.** A full GSM8K pack is roughly 1 extraction + 4 counterfactuals × N arguments + 3 predecessors × (generation + similarity judges) + 3 independence runs × 2 generations, before retries. At paper settings that is dozens of calls per record. The `Recipe` defaults and a per-record call budget with a hard ceiling need to be set deliberately, not discovered from an invoice.

---

## Next implementation step

Write `intent/state.py` and `intent/plan.py::schedule` against the Layer-1 upstream characterization harness — the scheduler and the restoration invariant are the highest-risk parity surface, they are pure, and they can be proven correct against `993d6be` before a single provider call is made.
