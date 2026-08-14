"""The revision-native event/artifact substrate (Strive vNext, Phase A).

One task/run-scoped, append-only, crash-framed, hash-chained event stream
(`strive.framing.FramedJournal`) plus a content-addressed object store
(`strive.cas.ObjectStore`) are the SOLE harness state. There is no
generation ledger, no revision mirror, no dual-write, no reader canary, and
no empirical-promotion gate: a policy may apply, observe, checkpoint, and
revert exact composite changes directly, and comparative evaluation is an
OPTIONAL observation a policy requests — never a universal activation
prerequisite.

The non-configurable floor is enforced here regardless of policy:

- **Allowlisted surfaces.** Every change touches only `(kind, name)` pairs
  in `SURFACE_ALLOWLIST`; anything else is refused.
- **Exact before/after state.** Every `SurfaceDelta` pins the exact
  `before`/`after` content by CAS ref, so a change is applied and inverted
  (reverted) deterministically, and a stale `before` is a conflict.
- **Expected-head conflict checks.** Authority appends carry the journal
  head they were decided against; a concurrent advance refuses the write.
- **CAS integrity.** Content is content-addressed and verified on read.
- **Append-only effects.** The event stream is append-only and
  tamper-evident (framed hash chain); nothing is rewritten.
- **Checkpoints / rollback / crash recovery.** State materializes by
  folding authority events; `PolicyCheckpointed` pins resumable policy
  state; a torn/again-unverified tail is quarantined, never honored.

Authority events (which move harness state), observations, and policy
annotations share ONE ordered stream but keep DISTINCT typed semantics:
only `ChangeApplied` and `ChangeReverted` (and the initial `PolicyBound`
seed) move state; everything else is analysis, annotation, or command
bookkeeping. External tracing (`strive.events.EventLog`) is a read-only
subscriber and is never required for operation.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from strive import codec
from strive.cas import ObjectCorruption, ObjectMissing, ObjectStore
from strive.codec import register
from strive.events import now_iso
from strive.framing import FramedJournal, FramingError

SUBSTRATE_STREAM = "strive-substrate@1"

# The non-configurable surface allowlist. A change may only touch these
# (kind, name) surfaces; the kernel and substrate both refuse anything else.
SURFACE_ALLOWLIST: frozenset[tuple[str, str]] = frozenset(
    {("strategy-code", "solve"), ("prompt", "proposal-template")}
)


class SubstrateError(Exception):
    """A substrate integrity or floor-violation failure."""


# -- composite state ------------------------------------------------------------------------------


@register("surface-binding", 1)
@dataclass(frozen=True)
class SurfaceBinding:
    """One surface bound to exact content by CAS ref."""

    kind: str
    name: str
    content_ref: str


@register("harness-state", 1)
@dataclass(frozen=True)
class HarnessState:
    """The whole composite harness state: a canonical, content-addressable
    set of surface bindings. This is the sole notion of "current state"."""

    bindings: tuple[SurfaceBinding, ...]

    def as_map(self) -> dict[tuple[str, str], str]:
        return {(b.kind, b.name): b.content_ref for b in self.bindings}

    def content_ref(self, kind: str, name: str) -> str | None:
        return self.as_map().get((kind, name))


def canonical_state(bindings: dict[tuple[str, str], str]) -> HarnessState:
    """Build a canonical (sorted) HarnessState from a (kind,name)->ref map."""
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
    """An exact before→after transition for one allowlisted surface. A
    ``None`` ref means the surface is absent on that side (create/delete)."""

    kind: str
    name: str
    before_ref: str | None
    after_ref: str | None


@register("composite-change", 1)
@dataclass(frozen=True)
class CompositeChange:
    """A coupled multi-surface change: exact per-surface before/after deltas.
    Immutable and content-addressable; the same change is applied and, by
    inversion, reverted."""

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


def validate_change(change: CompositeChange) -> None:
    """Floor check: allowlisted surfaces only, no no-op or duplicate delta."""
    seen: set[tuple[str, str]] = set()
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
    if not change.deltas:
        raise SubstrateError("a change must carry at least one delta")


def apply_change(state: HarnessState, change: CompositeChange) -> HarnessState:
    """Apply a change to a state EXACTLY: every delta's `before_ref` must
    equal the surface's current content (a stale before is a conflict);
    `after_ref=None` removes the surface. Returns the new canonical state."""
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


# -- event records (one ordered stream, distinct typed semantics) ---------------------------------


@register("policy-bound", 1)
@dataclass(frozen=True)
class PolicyBound:
    """AUTHORITY + identity. Pins the policy implementation, its exact frozen
    config, its versioned prompt refs, the seed, and the SEED composite state
    — the harness identity for this run. Model/provider choice travels in
    `run_metadata` as reproducibility metadata, NOT harness identity."""

    policy_ref: str  # name@version
    config_ref: str  # CAS ref of the frozen policy config
    prompt_refs: dict[str, str]  # role -> CAS ref of a versioned prompt md
    seed: int
    seed_state_ref: str  # CAS ref of the initial HarnessState
    run_metadata: dict[str, str]  # model id/provider/backend — NOT identity
    at: str


@register("policy-checkpointed", 1)
@dataclass(frozen=True)
class PolicyCheckpointed:
    """AUTHORITY. A resumable checkpoint: content-addressed policy state plus
    the current harness state ref, so a restart resumes without repeating
    completed model calls or side effects."""

    checkpoint_id: str
    policy_state_ref: str
    state_ref: str
    at: str


@register("policy-command-issued", 1)
@dataclass(frozen=True)
class PolicyCommandIssued:
    """COMMAND intent. Journaled BEFORE the kernel acts, so a crash mid-command
    is recoverable and a completed command is never repeated on restart."""

    command_id: str
    command_kind: str
    command_ref: str  # CAS ref of the exact command payload
    at: str


@register("policy-command-completed", 1)
@dataclass(frozen=True)
class PolicyCommandCompleted:
    """COMMAND result. Pairs with the issue record by `command_id`."""

    command_id: str
    outcome: str  # "ok" | "failed"
    result_ref: str | None  # CAS ref of the result payload
    at: str


@register("change-proposed", 1)
@dataclass(frozen=True)
class ChangeProposed:
    """ANALYSIS. A strategy proposed a change (possibly coupled multi-surface);
    proposing does NOT move state."""

    change_id: str
    change_ref: str
    strategy_ref: str  # which strategy@version proposed it
    at: str


@register("change-applied", 1)
@dataclass(frozen=True)
class ChangeApplied:
    """AUTHORITY. The change was applied: harness state moved from
    `before_state_ref` to `after_state_ref` (both full HarnessState refs)."""

    change_id: str
    change_ref: str
    before_state_ref: str
    after_state_ref: str
    at: str


@register("observation-recorded", 1)
@dataclass(frozen=True)
class ObservationRecorded:
    """OBSERVATION. Evidence ABOUT a state (e.g. an evaluation, a fork
    comparison). Distinct from authority: it never moves state."""

    observation_id: str
    subject_state_ref: str
    observation_kind: str
    observation_ref: str
    at: str


@register("change-confirmed", 1)
@dataclass(frozen=True)
class ChangeConfirmed:
    """ANNOTATION. A policy confirmed a previously-applied change (e.g. after
    an observation window). Bookkeeping, not a state move."""

    change_id: str
    rationale: str
    at: str


@register("change-revised", 1)
@dataclass(frozen=True)
class ChangeRevised:
    """ANNOTATION. A proposed/applied change was superseded by a revision."""

    change_id: str
    new_change_ref: str
    rationale: str
    at: str


@register("change-reverted", 1)
@dataclass(frozen=True)
class ChangeReverted:
    """AUTHORITY. A change was inverted and state restored exactly."""

    change_id: str
    revert_change_ref: str
    before_state_ref: str
    after_state_ref: str
    at: str


@register("operation-failed", 1)
@dataclass(frozen=True)
class OperationFailed:
    """AUTHORITY bookkeeping. A kernel operation failed, recorded fail-closed
    so the failure is auditable and never silently retried into a new
    side effect."""

    command_id: str
    kind: str
    detail: str
    at: str


_ENTRY_TYPES: tuple[type, ...] = (
    PolicyBound,
    PolicyCheckpointed,
    PolicyCommandIssued,
    PolicyCommandCompleted,
    ChangeProposed,
    ChangeApplied,
    ObservationRecorded,
    ChangeConfirmed,
    ChangeRevised,
    ChangeReverted,
    OperationFailed,
)


# -- the substrate store --------------------------------------------------------------------------


class _EventJournal(FramedJournal):
    def __init__(self, path: Path, task_id: str) -> None:
        super().__init__(path, task_id, SUBSTRATE_STREAM, _ENTRY_TYPES)


@dataclass(frozen=True)
class SubstrateView:
    """A materialized read: the current composite state, the journal head the
    read was taken at, and the ordered event entries."""

    state: HarnessState
    state_ref: str | None  # CAS ref of `state` (None before any PolicyBound)
    seed_state: HarnessState  # the pinned initial state (empty before binding)
    head: str
    entries: tuple[object, ...]
    bound: PolicyBound | None
    journal_errors: int


@dataclass(frozen=True)
class Substrate:
    """CAS + the append-only event stream for one task/run. The sole harness
    state; every authority append is head-checked and floor-enforced."""

    task_id: str
    objects: ObjectStore
    journal: _EventJournal

    # -- construction -----------------------------------------------------

    @staticmethod
    def open(root: Path, task_id: str) -> "Substrate":
        objects = ObjectStore(root / "objects")
        journal = _EventJournal(root / "events" / f"{task_id}.events.jsonl", task_id)
        return Substrate(task_id=task_id, objects=objects, journal=journal)

    # -- reads ------------------------------------------------------------

    def view(self) -> SubstrateView:
        framed = self.journal.read()
        bound: PolicyBound | None = None
        state_ref: str | None = None
        for entry in framed.entries:
            if isinstance(entry, PolicyBound):
                bound = entry
                state_ref = entry.seed_state_ref
            elif isinstance(entry, (ChangeApplied, ChangeReverted)):
                state_ref = entry.after_state_ref
        state = EMPTY_STATE
        if state_ref is not None:
            state = self._load_state(state_ref)
        seed_state = EMPTY_STATE
        if bound is not None:
            seed_state = self._load_state(bound.seed_state_ref)
        return SubstrateView(
            state=state,
            state_ref=state_ref,
            seed_state=seed_state,
            head=framed.head,
            entries=framed.entries,
            bound=bound,
            journal_errors=framed.errors,
        )

    def _load_state(self, state_ref: str) -> HarnessState:
        try:
            return codec.loads(self.objects.get_text(state_ref), HarnessState)
        except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
            raise SubstrateError(f"harness state {state_ref[:12]}… unreadable: {exc}")

    def completed_command_ids(self) -> set[str]:
        return {
            e.command_id
            for e in self.journal.read().entries
            if isinstance(e, PolicyCommandCompleted)
        }

    def issued_command_ids(self) -> set[str]:
        return {
            e.command_id
            for e in self.journal.read().entries
            if isinstance(e, PolicyCommandIssued)
        }

    def put(self, obj: object) -> str:
        """Content-address a registered contract (or a raw string, stored
        verbatim). Raw structured data must be wrapped in a registered type
        first — the substrate never stores unversioned blobs."""
        if isinstance(obj, str):
            return self.objects.put_text(obj)
        return self.objects.put_text(codec.dumps(obj))

    def put_state(self, state: HarnessState) -> str:
        return self.put(state)

    # -- authority appends (head-checked, floor-enforced) -----------------

    def _append(self, entry: object, expected_head: str | None) -> str:
        try:
            return self.journal.append_batch([entry], expected_head=expected_head)
        except FramingError as exc:
            raise SubstrateError(str(exc)) from None

    def bind_policy(
        self,
        *,
        policy_ref: str,
        config_ref: str,
        prompt_refs: dict[str, str],
        seed: int,
        seed_state: HarnessState,
        run_metadata: dict[str, str],
    ) -> PolicyBound:
        view = self.view()
        if view.bound is not None:
            raise SubstrateError("this run is already bound to a policy")
        record = PolicyBound(
            policy_ref=policy_ref,
            config_ref=config_ref,
            prompt_refs=dict(prompt_refs),
            seed=seed,
            seed_state_ref=self.put_state(seed_state),
            run_metadata=dict(run_metadata),
            at=now_iso(),
        )
        self._append(record, expected_head=view.head)
        return record

    def checkpoint(self, *, policy_state_ref: str, expected_head: str | None = None) -> str:
        view = self.view()
        checkpoint_id = f"ckpt-{len(self._of(PolicyCheckpointed)) + 1}"
        record = PolicyCheckpointed(
            checkpoint_id=checkpoint_id,
            policy_state_ref=policy_state_ref,
            state_ref=view.state_ref or "",
            at=now_iso(),
        )
        self._append(record, expected_head or view.head)
        return checkpoint_id

    def latest_checkpoint(self) -> PolicyCheckpointed | None:
        latest: PolicyCheckpointed | None = None
        for entry in self.journal.read().entries:
            if isinstance(entry, PolicyCheckpointed):
                latest = entry
        return latest

    def issue_command(
        self, *, command_id: str, command_kind: str, command: object,
        expected_head: str | None = None,
    ) -> str:
        record = PolicyCommandIssued(
            command_id=command_id,
            command_kind=command_kind,
            command_ref=self.put(command),
            at=now_iso(),
        )
        return self._append(record, expected_head)

    def complete_command(
        self, *, command_id: str, outcome: str, result: object | None,
    ) -> str:
        record = PolicyCommandCompleted(
            command_id=command_id,
            outcome=outcome,
            result_ref=self.put(result) if result is not None else None,
            at=now_iso(),
        )
        return self._append(record, expected_head=None)

    def record_proposal(
        self, *, change: CompositeChange, strategy_ref: str,
    ) -> str:
        return self._append(
            ChangeProposed(
                change_id=change.change_id,
                change_ref=self.put(change),
                strategy_ref=strategy_ref,
                at=now_iso(),
            ),
            expected_head=None,
        )

    def apply(self, *, change: CompositeChange, expected_head: str | None = None) -> HarnessState:
        """Apply a change as an AUTHORITY event: floor-checked, head-checked,
        and recorded with exact before/after full-state refs."""
        view = self.view()
        head = expected_head or view.head
        after = apply_change(view.state, change)
        before_ref = view.state_ref
        if before_ref is None:
            raise SubstrateError("cannot apply a change before the policy is bound")
        after_ref = self.put_state(after)
        self._append(
            ChangeApplied(
                change_id=change.change_id,
                change_ref=self.put(change),
                before_state_ref=before_ref,
                after_state_ref=after_ref,
                at=now_iso(),
            ),
            head,
        )
        return after

    def record_observation(
        self, *, observation_kind: str, observation: object,
        subject_state_ref: str | None = None,
    ) -> str:
        view = self.view()
        observation_id = f"obs-{len(self._of(ObservationRecorded)) + 1}"
        return self._append(
            ObservationRecorded(
                observation_id=observation_id,
                subject_state_ref=subject_state_ref or view.state_ref or "",
                observation_kind=observation_kind,
                observation_ref=self.put(observation),
                at=now_iso(),
            ),
            expected_head=None,
        )

    def confirm_change(self, *, change_id: str, rationale: str) -> str:
        return self._append(
            ChangeConfirmed(change_id=change_id, rationale=rationale, at=now_iso()),
            expected_head=None,
        )

    def revise_change(
        self, *, change_id: str, new_change: CompositeChange, rationale: str,
    ) -> str:
        return self._append(
            ChangeRevised(
                change_id=change_id,
                new_change_ref=self.put(new_change),
                rationale=rationale,
                at=now_iso(),
            ),
            expected_head=None,
        )

    def revert(self, *, change_id: str, expected_head: str | None = None) -> HarnessState:
        """Revert a previously-applied change by inverting it EXACTLY and
        head-checking the append. Fails closed if the recorded before-state
        no longer matches the current state (a later change intervened)."""
        view = self.view()
        head = expected_head or view.head
        applied = self._applied_change(change_id)
        if applied is None:
            raise SubstrateError(f"no applied change {change_id!r} to revert")
        change = codec.loads(self.objects.get_text(applied.change_ref), CompositeChange)
        revert = change.invert()
        after = apply_change(view.state, revert)
        before_ref = view.state_ref
        assert before_ref is not None
        after_ref = self.put_state(after)
        self._append(
            ChangeReverted(
                change_id=change_id,
                revert_change_ref=self.put(revert),
                before_state_ref=before_ref,
                after_state_ref=after_ref,
                at=now_iso(),
            ),
            head,
        )
        return after

    def record_failure(self, *, command_id: str, kind: str, detail: str) -> str:
        return self._append(
            OperationFailed(
                command_id=command_id, kind=kind, detail=detail, at=now_iso()
            ),
            expected_head=None,
        )

    # -- helpers ----------------------------------------------------------

    def _of(self, entry_type: type) -> list[object]:
        return [e for e in self.journal.read().entries if isinstance(e, entry_type)]

    def _applied_change(self, change_id: str) -> ChangeApplied | None:
        applied: ChangeApplied | None = None
        reverted: set[str] = set()
        for entry in self.journal.read().entries:
            if isinstance(entry, ChangeApplied) and entry.change_id == change_id:
                applied = entry
            elif isinstance(entry, ChangeReverted):
                reverted.add(entry.change_id)
        if change_id in reverted:
            return None  # already reverted
        return applied


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
    "HarnessState",
    "ObservationRecorded",
    "OperationFailed",
    "PolicyBound",
    "PolicyCheckpointed",
    "PolicyCommandCompleted",
    "PolicyCommandIssued",
    "Substrate",
    "SubstrateError",
    "SubstrateView",
    "SurfaceBinding",
    "SurfaceDelta",
    "apply_change",
    "canonical_state",
    "validate_change",
]
