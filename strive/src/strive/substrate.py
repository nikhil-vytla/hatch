"""The run-scoped, semantically-verified event/artifact substrate (vNext).

One artifact root holds many RUNS without collision: a content-addressed
object store shared at ``<root>/objects`` and, per run, an append-only,
crash-framed, hash-chained event stream at ``<root>/runs/<run_id>.events``.
Together they are the SOLE harness state. There is no generation ledger, no
revision mirror, no dual-write, no reader canary, no migration, and no
empirical-promotion gate: a policy applies, observes, checkpoints, and
reverts EXACT composite changes directly, and comparative evaluation is an
OPTIONAL mechanism a policy requests — never a universal activation
prerequisite.

Every event is an `EventEnvelope`: a kernel-generated stable id
(``<run_id>#<seq>``), the run/task scope, the command that CAUSED it, a
monotonic seq, a timestamp, and a CAS ref to a typed body. Authority bodies
(`PolicyBound`, `ChangeApplied`, `ChangeReverted`) move harness state;
observations and annotations never do; command bookkeeping
(`PolicyCommandIssued`/`Completed`, `PolicyCheckpointed`, `OperationFailed`)
makes the kernel resumable.

Nothing mutates over an UNVERIFIED log: `verify()` parses the whole stream
into a `VerifiedSubstrateView`, checking framing integrity, exactly-one
leading `PolicyBound`, full CAS closure, canonical/allowlisted state
bindings, an exact apply/revert replay, command-lifecycle and
command-digest consistency, checkpoint agreement, observation subjects, and
change-id uniqueness. A structural or semantic error REFUSES every
authority append (fail closed). Recovery — quarantine + truncate to the last
verified frame — is explicit (`repair`), never silent.
"""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from pathlib import Path

from strive import codec
from strive.cas import ObjectCorruption, ObjectMissing, ObjectStore, hash_text
from strive.codec import register
from strive.events import now_iso
from strive.framing import FramedJournal, FramingError

SUBSTRATE_STREAM = "strive-substrate@2"

SURFACE_ALLOWLIST: frozenset[tuple[str, str]] = frozenset(
    {("strategy-code", "solve"), ("prompt", "proposal-template")}
)


class SubstrateError(Exception):
    """A substrate integrity or floor-violation failure."""


def new_run_id(task_id: str) -> str:
    """A fresh, collision-free run id under one artifact root."""
    return f"run-{task_id}-{uuid.uuid4().hex[:12]}"


# -- composite state ------------------------------------------------------------------------------


@register("surface-binding", 1)
@dataclass(frozen=True)
class SurfaceBinding:
    kind: str
    name: str
    content_ref: str


@register("harness-state", 1)
@dataclass(frozen=True)
class HarnessState:
    """The whole composite harness state: a canonical, content-addressable
    set of surface bindings — the sole notion of "current state"."""

    bindings: tuple[SurfaceBinding, ...]

    def as_map(self) -> dict[tuple[str, str], str]:
        return {(b.kind, b.name): b.content_ref for b in self.bindings}

    def content_ref(self, kind: str, name: str) -> str | None:
        return self.as_map().get((kind, name))


def canonical_state(bindings: dict[tuple[str, str], str]) -> HarnessState:
    return HarnessState(
        bindings=tuple(
            SurfaceBinding(kind, name, ref)
            for (kind, name), ref in sorted(bindings.items())
        )
    )


EMPTY_STATE = HarnessState(bindings=())


@register("surface-delta", 2)
@dataclass(frozen=True)
class SurfaceDelta:
    kind: str
    name: str
    before_ref: str | None
    after_ref: str | None


@register("composite-change", 1)
@dataclass(frozen=True)
class CompositeChange:
    """A coupled multi-surface change: exact per-surface before/after deltas.
    Immutable and content-addressable; applied and, by inversion, reverted."""

    change_id: str
    deltas: tuple[SurfaceDelta, ...]
    summary: str

    def invert(self) -> "CompositeChange":
        return CompositeChange(
            change_id=f"{self.change_id}:revert",
            deltas=tuple(
                SurfaceDelta(d.kind, d.name, d.after_ref, d.before_ref)
                for d in self.deltas
            ),
            summary=f"revert of {self.change_id}: {self.summary}",
        )

    def referenced_refs(self) -> set[str]:
        refs: set[str] = set()
        for delta in self.deltas:
            if delta.after_ref is not None:
                refs.add(delta.after_ref)
        return refs


def validate_change(change: CompositeChange) -> None:
    seen: set[tuple[str, str]] = set()
    if not change.deltas:
        raise SubstrateError("a change must carry at least one delta")
    for delta in change.deltas:
        key = (delta.kind, delta.name)
        if key not in SURFACE_ALLOWLIST:
            raise SubstrateError(
                f"surface {key} is not allowlisted (allowed: "
                f"{sorted(SURFACE_ALLOWLIST)})"
            )
        if key in seen:
            raise SubstrateError(f"duplicate delta for surface {key}")
        seen.add(key)
        if delta.before_ref == delta.after_ref:
            raise SubstrateError(f"no-op delta for surface {key}")


def apply_change(state: HarnessState, change: CompositeChange) -> HarnessState:
    """Apply a change EXACTLY: every `before_ref` must equal the surface's
    current content (a stale before is a conflict); `after_ref=None` removes
    it. Returns the new canonical state."""
    validate_change(change)
    current = state.as_map()
    for delta in change.deltas:
        key = (delta.kind, delta.name)
        if current.get(key) != delta.before_ref:
            raise SubstrateError(
                f"stale before-state for {key}: change expects "
                f"{str(delta.before_ref)[:12]!r} but state holds "
                f"{str(current.get(key))[:12]!r}"
            )
        if delta.after_ref is None:
            current.pop(key, None)
        else:
            current[key] = delta.after_ref
    return canonical_state(current)


# -- event bodies (typed; the envelope carries id/scope/causation/time) ---------------------------


@register("policy-bound", 2)
@dataclass(frozen=True)
class PolicyBound:
    """AUTHORITY + identity. Pins the policy implementation, its exact frozen
    config, versioned prompt refs, seed, and the SEED composite state — the
    harness identity for this run. Model/provider is `run_metadata`
    (reproducibility), NOT identity."""

    policy_ref: str
    config_ref: str
    prompt_refs: dict[str, str]
    seed: int
    seed_state_ref: str
    run_metadata: dict[str, str]


@register("policy-checkpointed", 2)
@dataclass(frozen=True)
class PolicyCheckpointed:
    """AUTHORITY. A resumable checkpoint: content-addressed policy state, the
    current harness state ref, and the CONSUMED-result cursor (the last
    command whose result was reduced into this state)."""

    policy_state_ref: str
    state_ref: str
    consumed_command_id: str | None


@register("policy-command-issued", 2)
@dataclass(frozen=True)
class PolicyCommandIssued:
    """COMMAND intent. `command_ref` is the canonical digest of the command
    payload; the same `command_id` must always carry the same ref."""

    command_id: str
    command_kind: str
    command_ref: str


@register("policy-command-completed", 2)
@dataclass(frozen=True)
class PolicyCommandCompleted:
    """COMMAND terminal result (exactly one per command_id)."""

    command_id: str
    outcome: str  # "ok" | "failed"
    result_ref: str | None


@register("change-proposed", 2)
@dataclass(frozen=True)
class ChangeProposed:
    """ANALYSIS. A strategy proposed a change; proposing never moves state."""

    change_id: str
    change_ref: str
    strategy_ref: str


@register("change-applied", 2)
@dataclass(frozen=True)
class ChangeApplied:
    """AUTHORITY. State moved from `before_state_ref` to `after_state_ref`."""

    change_id: str
    change_ref: str
    before_state_ref: str
    after_state_ref: str


@register("observation-recorded", 2)
@dataclass(frozen=True)
class ObservationRecorded:
    """OBSERVATION about a state (e.g. a fork evaluation); never moves state."""

    subject_state_ref: str
    observation_kind: str
    observation_ref: str


@register("change-confirmed", 2)
@dataclass(frozen=True)
class ChangeConfirmed:
    change_id: str
    rationale: str


@register("change-revised", 2)
@dataclass(frozen=True)
class ChangeRevised:
    change_id: str
    new_change_ref: str
    rationale: str


@register("change-reverted", 2)
@dataclass(frozen=True)
class ChangeReverted:
    """AUTHORITY. A change was inverted and state restored exactly."""

    change_id: str
    revert_change_ref: str
    before_state_ref: str
    after_state_ref: str


@register("operation-failed", 2)
@dataclass(frozen=True)
class OperationFailed:
    """AUTHORITY bookkeeping. A kernel operation failed, recorded fail-closed."""

    command_id: str
    kind: str
    detail: str


@register("event-envelope", 1)
@dataclass(frozen=True)
class EventEnvelope:
    """The single stream record. Every event carries a stable id, run/task
    scope, causation, a monotonic seq, a timestamp, and a CAS ref to a typed
    body decoded on read."""

    event_id: str  # f"{run_id}#{seq}" — stable, unique within the run
    run_id: str
    task_id: str
    seq: int
    caused_by: str | None  # the command_id that caused this event
    body_kind: str
    body_ref: str
    at: str


_STATE_MOVING = ("change-applied@2", "change-reverted@2", "policy-bound@2")


# -- the journal ----------------------------------------------------------------------------------


class _EventJournal(FramedJournal):
    def __init__(self, path: Path, run_id: str) -> None:
        # the journal is bound to the RUN id, so streams never cross runs
        super().__init__(path, run_id, SUBSTRATE_STREAM, (EventEnvelope,))


# -- the verified view ----------------------------------------------------------------------------


@dataclass(frozen=True)
class VerifiedSubstrateView:
    """A fully parsed + verified read. `ok` is False (with `errors`) when the
    log has a structural or semantic defect; the substrate then REFUSES every
    authority append."""

    run_id: str
    task_id: str
    head: str
    seq: int  # number of verified envelopes
    ok: bool
    errors: tuple[str, ...]
    bound: PolicyBound | None
    state: HarnessState
    state_ref: str | None
    seed_state: HarnessState
    envelopes: tuple[EventEnvelope, ...]
    bodies: tuple[object, ...]  # index-aligned with envelopes
    issued: dict[str, PolicyCommandIssued]
    completed: dict[str, PolicyCommandCompleted]
    latest_checkpoint: PolicyCheckpointed | None
    applied_change_ids: frozenset[str]
    reverted_change_ids: frozenset[str]


# -- the substrate store --------------------------------------------------------------------------


@dataclass(frozen=True)
class Substrate:
    """CAS (shared across runs) + one run's append-only event stream. Every
    authority append verifies the whole log first and is head-checked."""

    root: Path
    task_id: str
    run_id: str
    objects: ObjectStore
    journal: _EventJournal

    @staticmethod
    def open(root: Path, task_id: str, run_id: str) -> "Substrate":
        objects = ObjectStore(root / "objects")
        journal = _EventJournal(root / "runs" / f"{run_id}.events.jsonl", run_id)
        return Substrate(
            root=root, task_id=task_id, run_id=run_id, objects=objects, journal=journal
        )

    @staticmethod
    def list_runs(root: Path) -> list[str]:
        runs_dir = root / "runs"
        if not runs_dir.exists():
            return []
        return sorted(
            p.name[: -len(".events.jsonl")]
            for p in runs_dir.glob("*.events.jsonl")
        )

    # -- CAS --------------------------------------------------------------

    def put(self, obj: object) -> str:
        if isinstance(obj, str):
            return self.objects.put_text(obj)
        return self.objects.put_text(codec.dumps(obj))

    def put_state(self, state: HarnessState) -> str:
        return self.put(state)

    def _load_state(self, state_ref: str) -> HarnessState:
        return codec.loads(self.objects.get_text(state_ref), HarnessState)

    def load_body(self, envelope: EventEnvelope) -> object:
        return codec.loads(self.objects.get_text(envelope.body_ref))

    # -- verification -----------------------------------------------------

    def verify(self) -> VerifiedSubstrateView:
        return _verify(self)

    def _require_ok(self, view: VerifiedSubstrateView, what: str) -> None:
        if not view.ok:
            raise SubstrateError(
                f"{what} refused: the substrate is not verifiable "
                f"({'; '.join(view.errors[:3])}). Repair it first."
            )

    # -- authority appends (verify → head-check → append) -----------------

    def _emit(
        self, body: object, *, caused_by: str | None, view: VerifiedSubstrateView
    ) -> VerifiedSubstrateView:
        envelope = EventEnvelope(
            event_id=f"{self.run_id}#{view.seq + 1}",
            run_id=self.run_id,
            task_id=self.task_id,
            seq=view.seq + 1,
            caused_by=caused_by,
            body_kind=codec.schema_of(type(body)),
            body_ref=self.put(body),
            at=now_iso(),
        )
        try:
            self.journal.append_batch([envelope], expected_head=view.head)
        except FramingError as exc:
            raise SubstrateError(str(exc)) from None
        return self.verify()

    def bind_policy(
        self,
        *,
        policy_ref: str,
        config_ref: str,
        prompt_refs: dict[str, str],
        seed: int,
        seed_state: HarnessState,
        run_metadata: dict[str, str],
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "bind")
        if view.bound is not None:
            raise SubstrateError("this run is already bound to a policy")
        record = PolicyBound(
            policy_ref=policy_ref,
            config_ref=config_ref,
            prompt_refs=dict(prompt_refs),
            seed=seed,
            seed_state_ref=self.put_state(seed_state),
            run_metadata=dict(run_metadata),
        )
        return self._emit(record, caused_by=None, view=view)

    def issue_command(
        self, *, command_id: str, command_kind: str, command_ref: str,
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "issue-command")
        prior = view.issued.get(command_id)
        if prior is not None and prior.command_ref != command_ref:
            raise SubstrateError(
                f"command id {command_id!r} reused with a different payload "
                f"digest ({prior.command_ref[:12]}… vs {command_ref[:12]}…) — "
                "fail closed"
            )
        return self._emit(
            PolicyCommandIssued(command_id, command_kind, command_ref),
            caused_by=command_id, view=view,
        )

    def complete_command(
        self, *, command_id: str, outcome: str, result: object | None,
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "complete-command")
        if command_id in view.completed:
            raise SubstrateError(
                f"command {command_id!r} already has a terminal completion"
            )
        return self._emit(
            PolicyCommandCompleted(
                command_id, outcome, self.put(result) if result is not None else None
            ),
            caused_by=command_id, view=view,
        )

    def checkpoint(
        self, *, policy_state_ref: str, consumed_command_id: str | None,
        caused_by: str | None,
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "checkpoint")
        return self._emit(
            PolicyCheckpointed(
                policy_state_ref=policy_state_ref,
                state_ref=view.state_ref or "",
                consumed_command_id=consumed_command_id,
            ),
            caused_by=caused_by, view=view,
        )

    def record_proposal(
        self, *, change: CompositeChange, strategy_ref: str, caused_by: str,
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "record-proposal")
        return self._emit(
            ChangeProposed(change.change_id, self.put(change), strategy_ref),
            caused_by=caused_by, view=view,
        )

    def stage_change_closure(self, change: CompositeChange, blobs: dict[str, str]) -> None:
        """Stage EXACTLY the CAS objects a change references, verifying each
        blob hashes to the ref the change points at. Full closure is required
        before apply (checked in verify's replay)."""
        needed = change.referenced_refs()
        for ref, content in blobs.items():
            if hash_text(content) != ref:
                raise SubstrateError(
                    f"staged content does not hash to its ref {ref[:12]}…"
                )
            self.objects.put_text(content)
        missing = {ref for ref in needed if not self.objects.has(ref)}
        if missing:
            raise SubstrateError(
                f"change {change.change_id!r} references CAS objects not "
                f"staged: {sorted(r[:12] for r in missing)}"
            )

    def apply(
        self, *, change: CompositeChange, caused_by: str,
        expected_head: str | None = None,
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "apply")
        if view.bound is None:
            raise SubstrateError("cannot apply before the policy is bound")
        if expected_head is not None and expected_head != view.head:
            raise SubstrateError(
                f"stale apply: authorized at head {expected_head.split(':')[0]} "
                f"but the run is at {view.head.split(':')[0]}"
            )
        validate_change(change)  # allowlist / shape before staging + apply
        for ref in change.referenced_refs():
            if not self.objects.has(ref):
                raise SubstrateError(
                    f"apply refused: change references un-staged CAS object "
                    f"{ref[:12]}… (stage the full closure first)"
                )
        after = apply_change(view.state, change)
        assert view.state_ref is not None
        return self._emit(
            ChangeApplied(
                change_id=change.change_id,
                change_ref=self.put(change),
                before_state_ref=view.state_ref,
                after_state_ref=self.put_state(after),
            ),
            caused_by=caused_by, view=view,
        )

    def record_observation(
        self, *, observation_kind: str, observation: object, subject_state_ref: str,
        caused_by: str,
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "record-observation")
        return self._emit(
            ObservationRecorded(
                subject_state_ref=subject_state_ref,
                observation_kind=observation_kind,
                observation_ref=self.put(observation),
            ),
            caused_by=caused_by, view=view,
        )

    def confirm_change(self, *, change_id: str, rationale: str, caused_by: str) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "confirm")
        return self._emit(
            ChangeConfirmed(change_id, rationale), caused_by=caused_by, view=view
        )

    def revert(
        self, *, change_id: str, caused_by: str, expected_head: str | None = None,
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "revert")
        if expected_head is not None and expected_head != view.head:
            raise SubstrateError(
                f"stale revert: authorized at head {expected_head.split(':')[0]} "
                f"but the run is at {view.head.split(':')[0]}"
            )
        if change_id not in view.applied_change_ids:
            raise SubstrateError(f"no applied change {change_id!r} to revert")
        if change_id in view.reverted_change_ids:
            raise SubstrateError(f"change {change_id!r} is already reverted")
        applied = _find_applied(view, change_id)
        assert applied is not None
        change = codec.loads(self.objects.get_text(applied.change_ref), CompositeChange)
        revert = change.invert()
        after = apply_change(view.state, revert)
        assert view.state_ref is not None
        return self._emit(
            ChangeReverted(
                change_id=change_id,
                revert_change_ref=self.put(revert),
                before_state_ref=view.state_ref,
                after_state_ref=self.put_state(after),
            ),
            caused_by=caused_by, view=view,
        )

    def record_failure(self, *, command_id: str, kind: str, detail: str) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "record-failure")
        return self._emit(
            OperationFailed(command_id, kind, detail), caused_by=command_id, view=view
        )

    # -- recovery ---------------------------------------------------------

    def repair(self, reason: str) -> str | None:
        """Explicit recovery: quarantine the FULL bytes and truncate to the
        last verified frame boundary. Returns the quarantine path, or None
        when nothing needed repair. This is the ONLY quarantine path — a
        merely-unverifiable-but-intact log is REFUSED, never auto-quarantined."""
        return self.journal.repair_to_verified(reason)


# -- verification implementation ------------------------------------------------------------------


def _find_applied(view: VerifiedSubstrateView, change_id: str) -> ChangeApplied | None:
    for body in view.bodies:
        if isinstance(body, ChangeApplied) and body.change_id == change_id:
            return body
    return None


def _verify(sub: Substrate) -> VerifiedSubstrateView:  # noqa: C901 — one place, exhaustive
    framed = sub.journal.read()
    errors: list[str] = []
    if framed.errors or framed.torn_tail:
        errors.append(
            f"journal has {framed.errors} unverifiable line(s)"
            + (", torn tail" if framed.torn_tail else "")
        )

    envelopes: list[EventEnvelope] = []
    bodies: list[object] = []
    for entry in framed.entries:
        assert isinstance(entry, EventEnvelope)
        envelopes.append(entry)

    def fail(state_ref: str | None, bound: PolicyBound | None) -> VerifiedSubstrateView:
        state = EMPTY_STATE
        seed = EMPTY_STATE
        try:
            if bound is not None:
                seed = sub._load_state(bound.seed_state_ref)
            if state_ref is not None:
                state = sub._load_state(state_ref)
        except (ObjectMissing, ObjectCorruption, codec.SchemaError):
            pass
        return VerifiedSubstrateView(
            run_id=sub.run_id, task_id=sub.task_id, head=framed.head,
            seq=len(envelopes), ok=False, errors=tuple(errors), bound=bound,
            state=state, state_ref=state_ref, seed_state=seed,
            envelopes=tuple(envelopes), bodies=tuple(bodies),
            issued={}, completed={}, latest_checkpoint=None,
            applied_change_ids=frozenset(), reverted_change_ids=frozenset(),
        )

    # envelope structure: monotonic seq, correct scope, stable id
    for index, env in enumerate(envelopes):
        if env.seq != index + 1:
            errors.append(f"envelope {index} has seq {env.seq}, expected {index + 1}")
        if env.run_id != sub.run_id:
            errors.append(f"envelope {env.seq} run_id {env.run_id!r} != {sub.run_id!r}")
        if env.event_id != f"{sub.run_id}#{env.seq}":
            errors.append(f"envelope {env.seq} has non-canonical id {env.event_id!r}")
        try:
            bodies.append(codec.loads(sub.objects.get_text(env.body_ref)))
        except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
            errors.append(f"envelope {env.seq} body unreadable: {exc}")
            bodies.append(None)
        else:
            if codec.schema_of(type(bodies[-1])) != env.body_kind:
                errors.append(f"envelope {env.seq} body_kind disagrees with its body")
    if errors:
        return fail(None, None)

    if not envelopes:  # a fresh, unbound run is verifiable
        return VerifiedSubstrateView(
            run_id=sub.run_id, task_id=sub.task_id, head=framed.head, seq=0,
            ok=True, errors=(), bound=None, state=EMPTY_STATE, state_ref=None,
            seed_state=EMPTY_STATE, envelopes=(), bodies=(), issued={},
            completed={}, latest_checkpoint=None,
            applied_change_ids=frozenset(), reverted_change_ids=frozenset(),
        )

    # exactly one leading PolicyBound
    bound_indices = [i for i, b in enumerate(bodies) if isinstance(b, PolicyBound)]
    if bound_indices != [0]:
        errors.append(
            "expected exactly one PolicyBound as the first event; found "
            f"{len(bound_indices)} at {bound_indices}"
        )
        return fail(None, None)
    bound = bodies[0]
    assert isinstance(bound, PolicyBound)

    # CAS closure of the bound identity
    for ref, what in [(bound.config_ref, "config"), (bound.seed_state_ref, "seed state")]:
        if not sub.objects.has(ref):
            errors.append(f"bound {what} ref {ref[:12]}… missing from CAS")
    for role, ref in bound.prompt_refs.items():
        if not sub.objects.has(ref):
            errors.append(f"bound prompt {role!r} ref {ref[:12]}… missing from CAS")

    seed_state = EMPTY_STATE
    try:
        seed_state = sub._load_state(bound.seed_state_ref)
        _verify_state(sub, seed_state, "seed state", errors)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        errors.append(f"seed state unreadable: {exc}")

    # fold authority events with an exact apply/revert replay
    state = seed_state
    state_ref: str | None = bound.seed_state_ref
    issued: dict[str, PolicyCommandIssued] = {}
    completed: dict[str, PolicyCommandCompleted] = {}
    latest_checkpoint: PolicyCheckpointed | None = None
    applied_ids: set[str] = set()
    reverted_ids: set[str] = set()
    seen_change_ids: set[str] = set()

    for env, body in zip(envelopes[1:], bodies[1:], strict=True):
        if isinstance(body, PolicyBound):
            errors.append(f"envelope {env.seq}: a second PolicyBound")
        elif isinstance(body, PolicyCommandIssued):
            prior = issued.get(body.command_id)
            if prior is not None and prior.command_ref != body.command_ref:
                errors.append(
                    f"command {body.command_id!r} reissued with a different digest"
                )
            issued.setdefault(body.command_id, body)
            if env.caused_by != body.command_id:
                errors.append(f"envelope {env.seq}: issue causation mismatch")
        elif isinstance(body, PolicyCommandCompleted):
            if body.command_id not in issued:
                errors.append(f"completion for un-issued command {body.command_id!r}")
            if body.command_id in completed:
                errors.append(
                    f"command {body.command_id!r} has more than one terminal completion"
                )
            completed[body.command_id] = body
        elif isinstance(body, (ChangeApplied, ChangeReverted)):
            new_ref, new_state = _replay(sub, state, state_ref, body, env, errors)
            state, state_ref = new_state, new_ref
            cid = body.change_id
            if isinstance(body, ChangeApplied):
                if cid in seen_change_ids:
                    errors.append(f"change id {cid!r} applied more than once")
                seen_change_ids.add(cid)
                applied_ids.add(cid)
            else:
                reverted_ids.add(cid)
        elif isinstance(body, PolicyCheckpointed):
            latest_checkpoint = body
            if body.state_ref != (state_ref or ""):
                errors.append(
                    f"envelope {env.seq}: checkpoint state_ref disagrees with "
                    "the folded state"
                )
        elif isinstance(body, ObservationRecorded):
            if body.subject_state_ref and not sub.objects.has(body.subject_state_ref):
                errors.append(
                    f"envelope {env.seq}: observation subject state missing from CAS"
                )
        elif isinstance(body, ChangeProposed):
            if not sub.objects.has(body.change_ref):
                errors.append(f"envelope {env.seq}: proposed change ref missing")
        # ChangeConfirmed / ChangeRevised / OperationFailed: annotation only

    ok = not errors
    return VerifiedSubstrateView(
        run_id=sub.run_id, task_id=sub.task_id, head=framed.head, seq=len(envelopes),
        ok=ok, errors=tuple(errors), bound=bound, state=state, state_ref=state_ref,
        seed_state=seed_state, envelopes=tuple(envelopes), bodies=tuple(bodies),
        issued=issued, completed=completed, latest_checkpoint=latest_checkpoint,
        applied_change_ids=frozenset(applied_ids),
        reverted_change_ids=frozenset(reverted_ids),
    )


def _verify_state(
    sub: Substrate, state: HarnessState, what: str, errors: list[str]
) -> None:
    seen: set[tuple[str, str]] = set()
    ordered = list(state.bindings)
    if ordered != sorted(ordered, key=lambda b: (b.kind, b.name)):
        errors.append(f"{what} bindings are not canonical (sorted)")
    for binding in state.bindings:
        key = (binding.kind, binding.name)
        if key in seen:
            errors.append(f"{what} has a duplicate binding {key}")
        seen.add(key)
        if key not in SURFACE_ALLOWLIST:
            errors.append(f"{what} binding {key} is not allowlisted")
        if not sub.objects.has(binding.content_ref):
            errors.append(f"{what} binding {key} content missing from CAS")


def _replay(
    sub: Substrate,
    state: HarnessState,
    state_ref: str | None,
    body: object,
    env: EventEnvelope,
    errors: list[str],
) -> tuple[str, HarnessState]:
    assert isinstance(body, (ChangeApplied, ChangeReverted))
    if body.before_state_ref != (state_ref or ""):
        errors.append(
            f"envelope {env.seq}: before_state_ref does not equal the prior state"
        )
    if env.caused_by is None:
        errors.append(f"envelope {env.seq}: authority effect does not cite a command")
    change_ref = (
        body.change_ref if isinstance(body, ChangeApplied) else body.revert_change_ref
    )
    try:
        change = codec.loads(sub.objects.get_text(change_ref), CompositeChange)
        recomputed = apply_change(state, change)
        recomputed_ref = sub.put_state(recomputed)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError, SubstrateError) as exc:
        errors.append(f"envelope {env.seq}: change does not replay: {exc}")
        return body.after_state_ref, state
    if recomputed_ref != body.after_state_ref:
        errors.append(
            f"envelope {env.seq}: deterministic application does not equal "
            "the recorded after_state_ref"
        )
    return body.after_state_ref, recomputed


__all__ = [
    "EMPTY_STATE",
    "SUBSTRATE_STREAM",
    "SURFACE_ALLOWLIST",
    "ChangeApplied",
    "ChangeConfirmed",
    "ChangeProposed",
    "ChangeReverted",
    "ChangeRevised",
    "CompositeChange",
    "EventEnvelope",
    "HarnessState",
    "ObservationRecorded",
    "OperationFailed",
    "PolicyBound",
    "PolicyCheckpointed",
    "PolicyCommandCompleted",
    "PolicyCommandIssued",
    "Substrate",
    "SubstrateError",
    "SurfaceBinding",
    "SurfaceDelta",
    "VerifiedSubstrateView",
    "apply_change",
    "canonical_state",
    "new_run_id",
    "validate_change",
]
