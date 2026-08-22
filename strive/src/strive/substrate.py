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

Run identity is EXACT. A `run_id` is an opaque, validated token (no path
separators, no ``..``); the task id is NEVER parsed out of it. A run's
identity — its task spec fingerprint, policy implementation digest, exact
frozen config, versioned prompt refs, seed + seed state, budget spec, the
required sandbox/semantic capability profile, and the surface catalog digest
— is pinned in the leading `PolicyBound` event (authoritative, hash-chained,
tamper-evident) AND mirrored into a `<root>/runs/<run_id>.binding.json`
discovery index. Resume loads the bound values and refuses any caller whose
values disagree.

Every event is an `EventEnvelope`: a kernel-generated stable id
(``<run_id>#<seq>``), the run/task scope, the command that CAUSED it, a
monotonic seq, a timestamp, and a CAS ref to a typed body decoded on read.

Nothing mutates over an UNVERIFIED log: `verify()` is PURE (it never writes
CAS) and CLOSED (it accepts only the known body union). It parses the whole
stream into a `VerifiedSubstrateView`, checking framing integrity,
exactly-one leading `PolicyBound` with full CAS closure and a matching
binding index + surface-catalog digest, canonical/catalogued state bindings,
an exact apply/revert replay, command-lifecycle and command-digest
consistency, checkpoint agreement, observation subjects, proposal refs, and
change-id uniqueness. On a structural OR semantic error the view is
``ok=False``, exposes NO active state, and every authority append is refused
(fail closed). Recovery — quarantine + truncate to the last verified frame —
is explicit (`repair`), never silent.
"""

from __future__ import annotations

import fcntl
import json
import math
import os
import re
import tempfile
import uuid
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Callable, Iterator, Mapping

from strive import codec
from strive.cas import ObjectCorruption, ObjectMissing, ObjectStore, hash_text
from strive.codec import register
from strive.contracts import BudgetSpec, BudgetUsage, Evaluation, ExecutionReport
from strive.events import now_iso
from strive.framing import FramedJournal, FramingError
from strive.runtime import (
    ENCODING,
    FORK_DISPATCH,
    FORK_RESULT,
    FORK_SUMMARY,
    OPERATION_DISPATCH,
    OPERATION_LABEL,
    OPERATION_RESULT,
    REFINE_BINDING,
    REFINE_DISPATCH,
    REFINE_RESULT,
    AttemptDispatched,
    AttemptRecord,
    CommandPayload,
    ConfigBlob,
    ForkObservation,
    ModelBinding,
    ModelDispatch,
    ModelResult,
    OperationDispatched,
    PolicyStateBlob,
    RefinementProposal,
    StoredResult,
    combine_usage,
    model_dispatch_reservation,
    model_result_usage,
    strict_encode,
)
from strive.refine import (
    RefinementDecodeError,
    decode_proposal,
    render_prompt,
)
from strive.surfaces import (
    SurfaceCatalog,
    SurfaceDescriptorSnapshot,
    SurfaceValidationError,
    default_surface_catalog,
)

SUBSTRATE_STREAM = "strive-substrate@4"

# which command kind may CAUSE each effect/annotation body (valid causation)
_CAUSE_COMPAT: dict[str, set[str]] = {
    "change-proposed@2": {"ApplyChange", "EvaluateFork", "RequestRefinement"},
    "change-applied@2": {"ApplyChange"},
    "change-reverted@2": {"RevertChange"},
    "observation-recorded@2": {
        "EvaluateFork", "RequestRefinement", "ObserveCurrentState",
    },
    "change-confirmed@2": {"ConfirmChange"},
    "change-revised@2": {"RequestRefinement"},
}

# the EXACT mandatory effect tokens a SUCCESSFUL command must cause (a token is
# an observation_kind for fork observations, else the body kind). A change may
# have been proposed by an EARLIER command (one proposal per change id), so a
# proposal caused by THIS command is optional.
_OK_EFFECTS: dict[str, dict[str, int]] = {
    "ApplyChange": {"change-applied@2": 1},
    "RevertChange": {"change-reverted@2": 1},
    "EvaluateFork": {
        "fork-attempt-dispatch": 2,
        "fork-attempt-result": 2,
        "fork-evaluation": 1,
    },
    "ConfirmChange": {"change-confirmed@2": 1},
    "RequestRefinement": {
        "refine-model-binding": 1,
        "refine-model-dispatch": 1,
        "refine-model-result": 1,
    },
    "ObserveCurrentState": {"operation-dispatch": 1, "operation-result": 1},
    "ScheduleTrigger": {},
    "StopAdaptation": {},
}
_OPTIONAL_OK_EFFECTS = {"change-proposed@2"}
_SUCCESS_TOKENS = {
    "change-applied@2", "change-reverted@2", "change-confirmed@2",
    "change-revised@2", "fork-evaluation",
}

# every normalized anchor a CommandPayload may carry
_PAYLOAD_FIELDS = (
    "change_ref", "target_change_id", "expected_state_ref", "issue_state_ref",
    "prompt_role", "context_ref", "after_seconds", "reason", "model_binding",
)

# The CLOSED per-kind command-intent spec: which normalized anchors are
# REQUIRED (non-null), which are OPTIONAL (may be null), which exact top-level
# keys the canonical JSON must carry, and — for a change-bearing kind — the
# JSON key holding the change subtree that `change_ref` must name. Every
# normalized field NOT listed required/optional is FORBIDDEN (must be null).
_PAYLOAD_SPECS: dict[
    str, tuple[frozenset[str], frozenset[str], frozenset[str], str | None]
] = {
    "ApplyChange": (
        frozenset({"change_ref", "target_change_id"}),
        frozenset({"expected_state_ref"}),
        frozenset({
            "command_id", "change", "strategy_ref", "content_blobs",
            "expected_state_ref",
        }),
        "change",
    ),
    "EvaluateFork": (
        frozenset({"change_ref", "target_change_id", "issue_state_ref"}),
        frozenset(),
        frozenset({"command_id", "candidate", "content_blobs", "detail"}),
        "candidate",
    ),
    "RevertChange": (
        frozenset({"target_change_id"}),
        frozenset({"expected_state_ref"}),
        frozenset({"command_id", "change_id", "expected_state_ref"}),
        None,
    ),
    "ConfirmChange": (
        frozenset({"target_change_id"}),
        frozenset(),
        frozenset({"command_id", "change_id", "rationale"}),
        None,
    ),
    "RequestRefinement": (
        frozenset({"prompt_role", "context_ref", "model_binding"}),
        frozenset(),
        frozenset({
            "command_id", "prompt_role", "model_role", "context_ref", "content_blobs",
            "required_change_id", "edit_limit", "enabled_surfaces", "edit_rule",
            "model_binding",
        }),
        None,
    ),
    "ObserveCurrentState": (
        frozenset(),
        frozenset(),
        frozenset({"command_id", "detail"}),
        None,
    ),
    "ScheduleTrigger": (
        frozenset({"after_seconds", "reason"}),
        frozenset(),
        frozenset({"command_id", "after_seconds", "reason"}),
        None,
    ),
    "StopAdaptation": (
        frozenset({"reason"}),
        frozenset(),
        frozenset({"command_id", "reason"}),
        None,
    ),
}

_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class SubstrateError(Exception):
    """A substrate integrity or floor-violation failure."""


# -- exact run identity ---------------------------------------------------------------------------


def validate_run_id(run_id: str) -> str:
    """A run id must be an opaque token safe as a filename component: it can
    never contain a path separator or ``..`` (traversal), be empty, or exceed
    128 chars. The TASK is discovered from the binding index — never parsed
    from the run id."""
    if not _RUN_ID_RE.match(run_id) or ".." in run_id:
        raise SubstrateError(
            f"invalid run id {run_id!r}: expected an opaque token "
            "(alnum . _ - , no separators, no '..')"
        )
    return run_id


def new_run_id() -> str:
    """A fresh, collision-free, OPAQUE run id. It deliberately encodes no task
    id: nothing may recover a task by string-parsing a run id."""
    return f"run-{uuid.uuid4().hex}"


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


def _shape_check(change: CompositeChange) -> None:
    """Catalog-INDEPENDENT shape rules: non-empty, no duplicate surface, no
    no-op delta. (Membership is checked separately — against the live catalog
    for reads, against the run's PINNED set for mutation.)"""
    seen: set[tuple[str, str]] = set()
    if not change.deltas:
        raise SubstrateError("a change must carry at least one delta")
    for delta in change.deltas:
        key = (delta.kind, delta.name)
        if key in seen:
            raise SubstrateError(f"duplicate delta for surface {key}")
        seen.add(key)
        if delta.before_ref == delta.after_ref:
            raise SubstrateError(f"no-op delta for surface {key}")


def validate_change(change: CompositeChange, catalog: SurfaceCatalog | None = None) -> None:
    _shape_check(change)
    cat = catalog or default_surface_catalog()
    for delta in change.deltas:
        key = (delta.kind, delta.name)
        if not cat.allows(*key):
            raise SubstrateError(
                f"surface {key} is not in the surface catalog "
                f"(allowed: {sorted(cat.keys())})"
            )


def _apply_deltas(state: HarnessState, change: CompositeChange) -> HarnessState:
    """Apply a change EXACTLY (shape-checked, NO catalog membership): every
    `before_ref` must equal the surface's current content (a stale before is a
    conflict); `after_ref=None` removes it. Returns the new canonical state."""
    _shape_check(change)
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


def apply_change(
    state: HarnessState, change: CompositeChange, catalog: SurfaceCatalog | None = None
) -> HarnessState:
    """Apply a change with catalog-membership validation (used for reads /
    replay). Mutation paths use pinned membership + `_apply_deltas` directly."""
    validate_change(change, catalog)
    return _apply_deltas(state, change)


# -- event bodies (typed; the envelope carries id/scope/causation/time) ---------------------------


@register("policy-bound", 4)
@dataclass(frozen=True)
class PolicyBound:
    """AUTHORITY + identity. Pins EVERYTHING that defines this run: the task
    id and its spec fingerprint, the policy implementation ref + package
    digest, the exact frozen config, versioned prompt refs, seed, the SEED
    composite state, the pinned budget spec, the required sandbox/semantic
    capability profile, and — PER SURFACE — the CAS ref of a pinned
    `SurfaceDescriptorSnapshot` (so adding a catalog surface never invalidates
    this run, and a validator implementation change is detected as drift).
    Model/provider is `run_metadata` (reproducibility), NOT identity."""

    task_id: str
    task_fingerprint: str
    policy_ref: str
    policy_digest: str
    config_ref: str
    prompt_refs: dict[str, str]
    seed: int
    seed_state_ref: str
    budget_ref: str
    required_capabilities: tuple[str, ...]
    surface_descriptor_refs: dict[str, str]  # "kind/name" -> descriptor snapshot ref
    run_metadata: dict[str, str]


@register("run-binding", 2)
@dataclass(frozen=True)
class RunBinding:
    """The DERIVED discovery index for a run, persisted at
    ``<root>/runs/<run_id>.binding.json``. It lets a tool learn a run's task
    WITHOUT string-parsing the run id. It is NOT authoritative: `PolicyBound`
    in the event stream is. It is rebuildable from the stream, and a divergent
    index is quarantined and rebuilt rather than invalidating a valid stream."""

    run_id: str
    task_id: str
    task_fingerprint: str
    policy_ref: str
    policy_digest: str
    config_ref: str
    prompt_refs: dict[str, str]
    seed: int
    seed_state_ref: str
    budget_ref: str
    required_capabilities: tuple[str, ...]
    surface_descriptor_refs: dict[str, str]

    @staticmethod
    def of(run_id: str, bound: PolicyBound) -> "RunBinding":
        return RunBinding(
            run_id=run_id,
            task_id=bound.task_id,
            task_fingerprint=bound.task_fingerprint,
            policy_ref=bound.policy_ref,
            policy_digest=bound.policy_digest,
            config_ref=bound.config_ref,
            prompt_refs=dict(bound.prompt_refs),
            seed=bound.seed,
            seed_state_ref=bound.seed_state_ref,
            budget_ref=bound.budget_ref,
            required_capabilities=tuple(bound.required_capabilities),
            surface_descriptor_refs=dict(bound.surface_descriptor_refs),
        )

    def agrees_with(self, bound: PolicyBound) -> bool:
        return self == RunBinding.of(self.run_id, bound)


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
    outcome: str  # "ok" | "failed" | "indeterminate"
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


@register("operation-failed", 3)
@dataclass(frozen=True)
class OperationFailed:
    """AUTHORITY bookkeeping. A kernel operation failed (or is indeterminate),
    recorded fail-closed. `outcome` (``failed`` | ``indeterminate``) is the
    terminal outcome this failure reconciles into, so a crash between the
    failure record and the terminal resumes to the SAME outcome without
    re-running the operation."""

    command_id: str
    kind: str
    detail: str
    outcome: str


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


# the CLOSED body union verify accepts — anything else fails the stream
_BODY_UNION: tuple[type, ...] = (
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
    authority append and exposes NO active state. Its mapping fields are
    read-only proxies (the public view is deeply immutable)."""

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
    issued: Mapping[str, PolicyCommandIssued]
    completed: Mapping[str, PolicyCommandCompleted]
    latest_checkpoint: PolicyCheckpointed | None
    applied_change_ids: frozenset[str]
    reverted_change_ids: frozenset[str]
    superseded_change_ids: frozenset[str]


# -- the substrate store --------------------------------------------------------------------------


@dataclass(frozen=True)
class Substrate:
    """CAS (shared across runs) + one run's append-only event stream, over an
    injected immutable `SurfaceCatalog`. Every authority append verifies the
    whole log first and is head-checked."""

    root: Path
    task_id: str
    run_id: str
    objects: ObjectStore
    journal: _EventJournal
    catalog: SurfaceCatalog

    @staticmethod
    def open(
        root: Path,
        task_id: str,
        run_id: str,
        *,
        catalog: SurfaceCatalog | None = None,
    ) -> "Substrate":
        validate_run_id(run_id)
        objects = ObjectStore(root / "objects")
        journal = _EventJournal(root / "runs" / f"{run_id}.events.jsonl", run_id)
        return Substrate(
            root=root, task_id=task_id, run_id=run_id, objects=objects,
            journal=journal, catalog=catalog or default_surface_catalog(),
        )

    @staticmethod
    def discover(
        root: Path, run_id: str, *, catalog: SurfaceCatalog | None = None
    ) -> "Substrate":
        """Open a run WITHOUT being told its task — the task id comes from the
        DERIVED binding index (never from parsing the run id). The authoritative
        source is the in-stream `PolicyBound`: if the index is missing it is
        rebuilt, and a divergent index (or one whose run_id disagrees with the
        opened run) is quarantined and rebuilt rather than trusted. A crash
        between the `PolicyBound` event and the index write is thus recovered."""
        validate_run_id(run_id)
        # first, learn the scope authoritatively from the stream's PolicyBound.
        peek = Substrate.open(root, "", run_id, catalog=catalog)
        stream_bound = peek._stream_policy_bound()
        if stream_bound is not None:
            sub = Substrate.open(root, stream_bound.task_id, run_id, catalog=catalog)
            sub.ensure_binding()  # rebuild/quarantine the derived index as needed
            return sub
        # no PolicyBound yet: trust the derived index only as a hint, and only
        # if its run_id matches the run we were asked to open.
        binding = _read_binding(root, run_id)
        if binding is not None and binding.run_id == run_id:
            return Substrate.open(root, binding.task_id, run_id, catalog=catalog)
        raise SubstrateError(
            f"cannot discover task for run {run_id!r}: no bound event and no "
            "matching binding index"
        )

    def _stream_policy_bound(self) -> "PolicyBound | None":
        """Read the FIRST envelope's body if it is a PolicyBound (authoritative
        scope), tolerating an otherwise-unverifiable tail. Returns None for an
        empty/unbound stream."""
        framed = self.journal.read()
        for entry in framed.entries:
            assert isinstance(entry, EventEnvelope)
            body: object
            try:
                body = codec.loads(self.objects.get_text(entry.body_ref))
            except (ObjectMissing, ObjectCorruption, codec.SchemaError):
                return None
            return body if isinstance(body, PolicyBound) else None
        return None

    def ensure_binding(self) -> str | None:
        """Reconcile the DERIVED binding index against the authoritative
        in-stream `PolicyBound`. Rebuilds a missing index (crash between the
        event and the index write); quarantines a divergent or run_id-mismatched
        index and rewrites the correct one. Never touches the event stream.
        Returns a quarantine path when one was taken, else None."""
        bound = self._stream_policy_bound()
        if bound is None:
            return None
        expected = RunBinding.of(self.run_id, bound)
        existing = _read_binding(self.root, self.run_id)
        if existing == expected:
            return None
        quarantine: str | None = None
        path = self._binding_path()
        if path.exists():
            quarantine = str(
                path.with_name(path.name + f".quarantine-{now_iso().replace(':', '')}")
            )
            os.replace(path, quarantine)  # preserve the divergent index
        self._write_binding(expected)
        return quarantine

    @staticmethod
    def list_runs(root: Path) -> list[str]:
        runs_dir = root / "runs"
        if not runs_dir.exists():
            return []
        return sorted(
            p.name[: -len(".events.jsonl")]
            for p in runs_dir.glob("*.events.jsonl")
        )

    def _binding_path(self) -> Path:
        return self.root / "runs" / f"{self.run_id}.binding.json"

    def _lease_path(self) -> Path:
        return self.root / "runs" / f"{self.run_id}.lease"

    @contextmanager
    def run_lease(self) -> Iterator[None]:
        """An exclusive, advisory RUN lease so two processes cannot drive (and
        execute commands for) the same run concurrently. Non-blocking: a second
        holder fails closed rather than racing. Released on exit/crash (the OS
        drops the flock when the fd closes)."""
        path = self._lease_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open("a")
        try:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise SubstrateError(
                    f"run {self.run_id!r} is already being driven by another "
                    "process (run lease held) — refusing concurrent execution"
                ) from None
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

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
        """Append ONE authority event ATOMICALLY: the candidate envelope is
        preflighted through a PURE fold of the resulting stream, and the append
        is refused unless the POST-event view is fully valid. So an accepted
        append can never turn a valid run invalid; a rejected one leaves the
        journal byte-for-byte unchanged (only an orphan CAS body may remain)."""
        envelope = EventEnvelope(
            event_id=f"{self.run_id}#{view.seq + 1}",
            run_id=self.run_id,
            task_id=self.task_id,
            seq=view.seq + 1,
            caused_by=caused_by,
            body_kind=codec.schema_of(type(body)),
            body_ref=self.put(body),  # orphan-safe: no journal write yet
            at=now_iso(),
        )
        post = _fold_view(self, view.head, list(view.envelopes) + [envelope], [])
        if not post.ok:
            raise SubstrateError(
                "refusing to append: the resulting run would be invalid "
                f"({'; '.join(post.errors[:3])})"
            )
        try:
            self.journal.append_batch([envelope], expected_head=view.head)
        except FramingError as exc:
            raise SubstrateError(str(exc)) from None
        return self.verify()

    def bind_policy(
        self,
        *,
        task_fingerprint: str,
        policy_ref: str,
        policy_digest: str,
        config_ref: str,
        prompt_refs: dict[str, str],
        seed: int,
        seed_state: HarnessState,
        budget_ref: str,
        required_capabilities: tuple[str, ...],
        run_metadata: dict[str, str],
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "bind")
        if view.bound is not None:
            raise SubstrateError("this run is already bound to a policy")
        # PREFLIGHT every bound ref before appending an authoritative event:
        # config is hash-verified (opaque to the substrate; the KERNEL decodes
        # it), budget must decode as a BudgetSpec, prompts hash-verify.
        try:
            self.objects.get_text(config_ref)
            codec.loads(self.objects.get_text(budget_ref), BudgetSpec)
        except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
            raise SubstrateError(f"bound config/budget ref invalid: {exc}") from None
        for role, ref in prompt_refs.items():
            try:
                self.objects.get_text(ref)
            except (ObjectMissing, ObjectCorruption) as exc:
                raise SubstrateError(f"bound prompt {role!r} ref invalid: {exc}") from None
        # trusted structural validation of every seed binding BEFORE seeding
        for binding in seed_state.bindings:
            if not self.catalog.allows(binding.kind, binding.name):
                raise SubstrateError(
                    f"seed binding {(binding.kind, binding.name)} not in catalog"
                )
            try:
                self.catalog.validate_content(
                    binding.kind, binding.name,
                    self.objects.get_text(binding.content_ref),
                )
            except (SurfaceValidationError, ObjectMissing, ObjectCorruption) as exc:
                raise SubstrateError(
                    f"seed binding {(binding.kind, binding.name)} invalid: {exc}"
                ) from None
        # pin a versioned descriptor snapshot ref for every catalog surface, so
        # later catalog additions never invalidate this run and a validator
        # implementation change is detectable as drift.
        surface_descriptor_refs = {
            key: self.put(snapshot)
            for key, snapshot in self.catalog.snapshots().items()
        }
        record = PolicyBound(
            task_id=self.task_id,
            task_fingerprint=task_fingerprint,
            policy_ref=policy_ref,
            policy_digest=policy_digest,
            config_ref=config_ref,
            prompt_refs=dict(prompt_refs),
            seed=seed,
            seed_state_ref=self.put_state(seed_state),
            budget_ref=budget_ref,
            required_capabilities=tuple(required_capabilities),
            surface_descriptor_refs=surface_descriptor_refs,
            run_metadata=dict(run_metadata),
        )
        updated = self._emit(record, caused_by=None, view=view)
        # persist the DERIVED discovery index AFTER the authoritative event
        self._write_binding(RunBinding.of(self.run_id, record))
        return updated

    def _write_binding(self, binding: RunBinding) -> None:
        path = self._binding_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        text = codec.dumps(binding)
        if path.exists() and path.read_text(encoding="utf-8") == text:
            return
        if path.exists():
            raise SubstrateError(
                f"run {self.run_id!r} binding index already exists with different "
                "content — refusing to overwrite an established binding"
            )
        fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise

    def issue_command(
        self, *, command_id: str, command_kind: str, command_ref: str,
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "issue-command")
        prior = view.issued.get(command_id)
        if prior is not None:
            if prior.command_ref != command_ref:
                raise SubstrateError(
                    f"command id {command_id!r} reused with a different payload "
                    f"digest ({prior.command_ref[:12]}… vs {command_ref[:12]}…) — "
                    "fail closed"
                )
            # same id + same digest: an IDEMPOTENT READ, not a second intent —
            # never append a duplicate PolicyCommandIssued.
            return view
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

    def _pinned(self, view: VerifiedSubstrateView) -> dict[str, SurfaceDescriptorSnapshot]:
        """The run's PINNED surface descriptor snapshots (from PolicyBound),
        loaded + decoded. A run may only mutate/validate through THESE."""
        assert view.bound is not None
        pinned: dict[str, SurfaceDescriptorSnapshot] = {}
        for key, ref in view.bound.surface_descriptor_refs.items():
            pinned[key] = codec.loads(self.objects.get_text(ref), SurfaceDescriptorSnapshot)
        return pinned

    def _validate_pinned_content(
        self, pinned: dict[str, SurfaceDescriptorSnapshot], kind: str, name: str, content: str
    ) -> None:
        snap = pinned.get(f"{kind}/{name}")
        if snap is None:
            raise SubstrateError(
                f"surface {(kind, name)} is not pinned in this run (a rebind/new "
                "run is required to mutate it)"
            )
        try:
            descriptor = self.catalog.resolve_pinned(snap)  # refuses validator drift
            descriptor.validator(content)
        except SurfaceValidationError as exc:
            raise SubstrateError(
                f"content for {(kind, name)} is invalid under the pinned "
                f"descriptor: {exc}"
            ) from None

    def pinned_validator(
        self, view: VerifiedSubstrateView
    ) -> Callable[[str, str, str], None]:
        """A surface-content validator bound to the run's PINNED descriptors (not
        the live catalog): `(kind, name, content) -> None`, raising
        `SurfaceValidationError` for an off-limits surface or invalid content.
        Used to decode a refinement proposal against run-pinned descriptors."""
        pinned = self._pinned(view)

        def validate(kind: str, name: str, content: str) -> None:
            snap = pinned.get(f"{kind}/{name}")
            if snap is None:
                raise SurfaceValidationError(
                    f"surface {(kind, name)} is not pinned in this run"
                )
            self.catalog.resolve_pinned(snap).validator(content)

        return validate

    def stage_change_closure(self, change: CompositeChange, blobs: dict[str, str]) -> None:
        """Stage EXACTLY the CAS objects a change references, verifying each
        blob hashes to its ref. Reject any UNRELATED staged blob. Then validate
        EVERY referenced surface artifact structurally THROUGH THE RUN'S PINNED
        descriptors — even one already present in the shared CAS — so a change
        can never install content that would fail its surface's pinned
        validator, and can never touch a surface the run did not pin."""
        view = self.verify()
        self._require_ok(view, "stage-change")
        if view.bound is None:
            raise SubstrateError("cannot stage a change before the policy is bound")
        pinned = self._pinned(view)
        _shape_check(change)
        after_surface = {
            d.after_ref: (d.kind, d.name)
            for d in change.deltas
            if d.after_ref is not None
        }
        for delta in change.deltas:  # membership: only pinned surfaces
            if f"{delta.kind}/{delta.name}" not in pinned:
                raise SubstrateError(
                    f"change touches surface {(delta.kind, delta.name)} not pinned "
                    "in this run"
                )
        needed = change.referenced_refs()
        unrelated = set(blobs) - needed
        if unrelated:
            raise SubstrateError(
                f"refusing unrelated staged blob(s) not referenced by change "
                f"{change.change_id!r}: {sorted(r[:12] for r in unrelated)}"
            )
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
        # validate EVERY referenced surface artifact through the PINNED
        # descriptor, incl. ones already shared in CAS
        for ref, (kind, name) in after_surface.items():
            try:
                content = self.objects.get_text(ref)
            except (ObjectMissing, ObjectCorruption) as exc:
                raise SubstrateError(
                    f"referenced content for {(kind, name)} unreadable: {exc}"
                ) from None
            self._validate_pinned_content(pinned, kind, name, content)

    def apply(
        self, *, change: CompositeChange, caused_by: str,
        expected_state_ref: str | None = None,
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "apply")
        if view.bound is None:
            raise SubstrateError("cannot apply before the policy is bound")
        # expected-state is LOGICAL (the composite harness state ref), so it is
        # robust to intervening non-state-moving events (proposals, the kernel's
        # own intent). A stale expected state is a real conflict.
        if expected_state_ref is not None and expected_state_ref != view.state_ref:
            raise SubstrateError(
                f"stale apply: authorized against state "
                f"{str(expected_state_ref)[:12]!r} but the run's state is "
                f"{str(view.state_ref)[:12]!r}"
            )
        _shape_check(change)
        pinned = self._pinned(view)
        for delta in change.deltas:  # only PINNED surfaces may be mutated
            if f"{delta.kind}/{delta.name}" not in pinned:
                raise SubstrateError(
                    f"apply refused: surface {(delta.kind, delta.name)} is not "
                    "pinned in this run (rebind/new run required)"
                )
        for ref in change.referenced_refs():
            if not self.objects.has(ref):
                raise SubstrateError(
                    f"apply refused: change references un-staged CAS object "
                    f"{ref[:12]}… (stage the full closure first)"
                )
        after = _apply_deltas(view.state, change)
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
        self, *, change_id: str, caused_by: str, expected_state_ref: str | None = None,
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "revert")
        if expected_state_ref is not None and expected_state_ref != view.state_ref:
            raise SubstrateError(
                f"stale revert: authorized against state "
                f"{str(expected_state_ref)[:12]!r} but the run's state is "
                f"{str(view.state_ref)[:12]!r}"
            )
        if change_id not in view.applied_change_ids:
            raise SubstrateError(f"no applied change {change_id!r} to revert")
        if change_id in view.reverted_change_ids:
            raise SubstrateError(f"change {change_id!r} is already reverted")
        applied = _find_applied(view, change_id)
        assert applied is not None
        change = codec.loads(self.objects.get_text(applied.change_ref), CompositeChange)
        revert = change.invert()
        after = _apply_deltas(view.state, revert)  # surfaces already pinned (applied)
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

    def record_failure(
        self, *, command_id: str, kind: str, detail: str, outcome: str = "failed",
    ) -> VerifiedSubstrateView:
        view = self.verify()
        self._require_ok(view, "record-failure")
        return self._emit(
            OperationFailed(command_id, kind, detail, outcome),
            caused_by=command_id, view=view,
        )

    # -- recovery ---------------------------------------------------------

    def repair(self, reason: str) -> str | None:
        """Explicit recovery: quarantine the FULL bytes and truncate to the
        last verified frame boundary. Returns the quarantine path, or None
        when nothing needed repair. This is the ONLY quarantine path — a
        merely-unverifiable-but-intact log is REFUSED, never auto-quarantined."""
        return self.journal.repair_to_verified(reason)


# -- binding index io -----------------------------------------------------------------------------


def _read_binding(root: Path, run_id: str) -> RunBinding | None:
    path = root / "runs" / f"{run_id}.binding.json"
    if not path.exists():
        return None
    try:
        return codec.loads(path.read_text(encoding="utf-8"), RunBinding)
    except (codec.SchemaError, OSError):
        return None


# -- verification implementation ------------------------------------------------------------------


def _find_applied(view: VerifiedSubstrateView, change_id: str) -> ChangeApplied | None:
    for body in view.bodies:
        if isinstance(body, ChangeApplied) and body.change_id == change_id:
            return body
    return None


def _verify(sub: Substrate) -> VerifiedSubstrateView:
    """Read the journal and fold it into a verified view (pure — no writes)."""
    framed = sub.journal.read()
    framing_errors: list[str] = []
    if framed.errors or framed.torn_tail:
        framing_errors.append(
            f"journal has {framed.errors} unverifiable line(s)"
            + (", torn tail" if framed.torn_tail else "")
        )
    envelopes: list[EventEnvelope] = []
    for entry in framed.entries:
        assert isinstance(entry, EventEnvelope)
        envelopes.append(entry)
    return _fold_view(sub, framed.head, envelopes, framing_errors)


def _fold_view(  # noqa: C901 — one place, exhaustive
    sub: Substrate,
    head: str,
    envelopes: list[EventEnvelope],
    framing_errors: list[str],
) -> VerifiedSubstrateView:
    """The PURE fold over a candidate list of envelopes. Used both to verify
    the persisted stream and to PREFLIGHT a would-be append (existing envelopes
    plus one candidate) before it is written."""
    errors: list[str] = list(framing_errors)
    bodies: list[object] = []

    def fail(bound: PolicyBound | None) -> VerifiedSubstrateView:
        # NEVER expose active state from an unverifiable stream — seed and
        # active state are both withheld (EMPTY) so no caller can act on them.
        return VerifiedSubstrateView(
            run_id=sub.run_id, task_id=sub.task_id, head=head,
            seq=len(envelopes), ok=False, errors=tuple(errors), bound=bound,
            state=EMPTY_STATE, state_ref=None, seed_state=EMPTY_STATE,
            envelopes=tuple(envelopes), bodies=tuple(bodies),
            issued=MappingProxyType({}), completed=MappingProxyType({}),
            latest_checkpoint=None,
            applied_change_ids=frozenset(), reverted_change_ids=frozenset(),
            superseded_change_ids=frozenset(),
        )

    # envelope structure: monotonic seq, correct scope, stable id, CLOSED body
    for index, env in enumerate(envelopes):
        if env.seq != index + 1:
            errors.append(f"envelope {index} has seq {env.seq}, expected {index + 1}")
        if env.run_id != sub.run_id:
            errors.append(f"envelope {env.seq} run_id {env.run_id!r} != {sub.run_id!r}")
        if env.task_id != sub.task_id:
            errors.append(
                f"envelope {env.seq} task_id {env.task_id!r} != {sub.task_id!r} "
                "(cross-task scope forgery)"
            )
        if env.event_id != f"{sub.run_id}#{env.seq}":
            errors.append(f"envelope {env.seq} has non-canonical id {env.event_id!r}")
        body: object
        try:
            body = codec.loads(sub.objects.get_text(env.body_ref))
        except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
            errors.append(f"envelope {env.seq} body unreadable: {exc}")
            bodies.append(None)
            continue
        bodies.append(body)
        if not isinstance(body, _BODY_UNION):
            errors.append(
                f"envelope {env.seq} body kind {env.body_kind!r} is not in the "
                "closed substrate body union"
            )
        elif codec.schema_of(type(body)) != env.body_kind:
            errors.append(f"envelope {env.seq} body_kind disagrees with its body")
    if errors:
        return fail(None)

    if not envelopes:  # a fresh, unbound run is verifiable
        return VerifiedSubstrateView(
            run_id=sub.run_id, task_id=sub.task_id, head=head, seq=0,
            ok=True, errors=(), bound=None, state=EMPTY_STATE, state_ref=None,
            seed_state=EMPTY_STATE, envelopes=(), bodies=(),
            issued=MappingProxyType({}), completed=MappingProxyType({}),
            latest_checkpoint=None,
            applied_change_ids=frozenset(), reverted_change_ids=frozenset(),
            superseded_change_ids=frozenset(),
        )

    # exactly one leading PolicyBound
    bound_indices = [i for i, b in enumerate(bodies) if isinstance(b, PolicyBound)]
    if bound_indices != [0]:
        errors.append(
            "expected exactly one PolicyBound as the first event; found "
            f"{len(bound_indices)} at {bound_indices}"
        )
        return fail(None)
    bound = bodies[0]
    assert isinstance(bound, PolicyBound)

    # bound task scope must match the opened run. The binding index is DERIVED
    # (reconciled by discover/ensure_binding) and is deliberately NOT part of
    # stream validity — a valid stream is never invalidated by a missing index.
    if bound.task_id != sub.task_id:
        errors.append(
            f"bound task id {bound.task_id!r} disagrees with the opened scope "
            f"{sub.task_id!r}"
        )

    # decode + hash-verify the bound identity refs — has() alone is insufficient
    try:
        cfg = codec.loads(sub.objects.get_text(bound.config_ref), ConfigBlob)
        if cfg.encoding != ENCODING:
            errors.append(f"bound config encoding {cfg.encoding!r} != {ENCODING!r}")
        if not _canonical_json_ok(cfg.json):
            errors.append("bound config json is malformed or noncanonical")
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        errors.append(f"bound config ref does not decode: {exc}")
    try:
        codec.loads(sub.objects.get_text(bound.budget_ref), BudgetSpec)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        errors.append(f"bound budget ref does not decode: {exc}")
    for role, ref in bound.prompt_refs.items():
        try:
            sub.objects.get_text(ref)
        except (ObjectMissing, ObjectCorruption) as exc:
            errors.append(f"bound prompt {role!r} ref unreadable: {exc}")

    # resolve the run's PINNED surface descriptor snapshots (version-safe)
    pinned = _load_pinned_snapshots(sub, bound, errors)

    seed_state = EMPTY_STATE
    try:
        seed_state = sub._load_state(bound.seed_state_ref)
        _verify_state(sub, seed_state, "seed state", errors, pinned)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        errors.append(f"seed state unreadable: {exc}")

    # fold authority events with an exact, PURE apply/revert replay
    state = seed_state
    state_ref: str | None = bound.seed_state_ref
    issued: dict[str, PolicyCommandIssued] = {}
    issue_states: dict[str, str | None] = {}  # folded state at each issue
    payloads: dict[str, CommandPayload] = {}
    completed: dict[str, PolicyCommandCompleted] = {}
    latest_checkpoint: PolicyCheckpointed | None = None
    applied_ids: set[str] = set()
    reverted_ids: set[str] = set()
    superseded_ids: set[str] = set()  # change ids retired by a later revision
    applied_changes: dict[str, CompositeChange] = {}
    proposals: dict[str, str] = {}  # change_id -> change_ref (one per change id)
    consumed_cmds: set[str] = set()  # a command is reduced by AT MOST one checkpoint

    for env, body in zip(envelopes[1:], bodies[1:], strict=True):
        kind = env.body_kind
        if isinstance(body, PolicyBound):
            errors.append(f"envelope {env.seq}: a second PolicyBound")
            continue
        if isinstance(body, PolicyCommandIssued):
            # duplicate intents are REJECTED even with the same digest
            if body.command_id in issued:
                errors.append(
                    f"envelope {env.seq}: duplicate intent for command "
                    f"{body.command_id!r} (issued at most once)"
                )
            elif env.caused_by != body.command_id:
                errors.append(f"envelope {env.seq}: an issue must be self-caused")
            # decode the payload as a typed CommandPayload and match its scope
            try:
                payload = codec.loads(sub.objects.get_text(body.command_ref), CommandPayload)
                if payload.command_id != body.command_id:
                    errors.append(f"envelope {env.seq}: payload command_id disagrees")
                if payload.kind != body.command_kind:
                    errors.append(f"envelope {env.seq}: payload kind disagrees with intent")
                if not _canonical_json_ok(payload.json):
                    errors.append(
                        f"envelope {env.seq}: command payload json is malformed or "
                        "noncanonical"
                    )
                _check_command_payload_coherence(sub, env, payload, errors)
                # a fork's issue_state_ref is the base anchor: it MUST equal the
                # state folded at the moment the fork was issued — not an
                # arbitrary ref the policy chose.
                if (
                    payload.kind == "EvaluateFork"
                    and payload.issue_state_ref != state_ref
                ):
                    errors.append(
                        f"envelope {env.seq}: fork issue_state_ref does not equal the "
                        "folded state at issue"
                    )
                payloads.setdefault(body.command_id, payload)
            except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
                errors.append(f"envelope {env.seq}: command payload does not decode: {exc}")
            issued.setdefault(body.command_id, body)
            issue_states.setdefault(body.command_id, state_ref)
            continue

        # every non-bound, non-issue event must cite an ISSUED command that
        # appears EARLIER (valid order) and is of a COMPATIBLE kind.
        cause = env.caused_by
        cause_issue = issued.get(cause) if cause is not None else None
        cause_payload = payloads.get(cause) if cause is not None else None
        if cause is None or cause_issue is None:
            errors.append(
                f"envelope {env.seq} ({kind}) does not cite an issued command"
            )
        elif kind in _CAUSE_COMPAT and cause_issue.command_kind not in _CAUSE_COMPAT[kind]:
            errors.append(
                f"envelope {env.seq}: {kind} caused by incompatible command kind "
                f"{cause_issue.command_kind!r}"
            )

        if isinstance(body, PolicyCommandCompleted):
            if body.command_id not in issued:
                errors.append(f"completion for un-issued command {body.command_id!r}")
            if body.command_id in completed:
                errors.append(
                    f"command {body.command_id!r} has more than one terminal completion"
                )
            if cause != body.command_id:
                errors.append(f"envelope {env.seq}: completion must be self-caused")
            if body.outcome not in ("ok", "failed", "indeterminate"):
                errors.append(f"envelope {env.seq}: unknown outcome {body.outcome!r}")
            # EVERY terminal — ok, failed, OR indeterminate — has a StoredResult
            if body.result_ref is None:
                errors.append(f"envelope {env.seq}: terminal has no StoredResult")
            else:
                try:
                    stored = codec.loads(sub.objects.get_text(body.result_ref), StoredResult)
                    if stored.command_id != body.command_id:
                        errors.append(f"envelope {env.seq}: result command_id disagrees")
                    if stored.outcome != body.outcome:
                        errors.append(f"envelope {env.seq}: result outcome disagrees")
                    issue = issued.get(body.command_id)
                    if issue is not None and stored.kind != issue.command_kind:
                        errors.append(f"envelope {env.seq}: result kind disagrees with intent")
                    # the EXACT pre-terminal semantic head: position + folded state
                    expected_head = f"{env.seq - 1}:{state_ref or ''}"
                    if stored.head != expected_head:
                        errors.append(
                            f"envelope {env.seq}: result head {stored.head!r} != the "
                            f"pre-terminal semantic head {expected_head!r}"
                        )
                except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
                    errors.append(f"envelope {env.seq}: result ref does not decode: {exc}")
            completed[body.command_id] = body
        elif isinstance(body, ChangeApplied):
            new_ref, new_state = _replay(sub, state, state_ref, body, env, errors)
            state, state_ref = new_state, new_ref
            cid = body.change_id
            if cid in applied_ids:
                errors.append(f"change id {cid!r} applied more than once")
            applied_ids.add(cid)
            change = _decode_change(sub, body.change_ref, env, errors)
            if change is not None:
                if change.change_id != cid:
                    errors.append(f"envelope {env.seq}: applied change id/ref disagree")
                _require_pinned_deltas(change, bound, env, errors)
                applied_changes[cid] = change
            # the applied change must match BOTH its proposal AND the durable
            # command payload's target change — not merely a command kind.
            if proposals.get(cid) != body.change_ref:
                errors.append(
                    f"envelope {env.seq}: applied change does not match its proposal"
                )
            if cause_payload is not None:
                if cause_payload.change_ref != body.change_ref:
                    errors.append(
                        f"envelope {env.seq}: applied change does not match the issued "
                        "command payload"
                    )
                if cause_payload.target_change_id not in (None, cid):
                    errors.append(
                        f"envelope {env.seq}: applied change id != the command's "
                        "named target"
                    )
                # the effect must satisfy the ISSUED expected_state_ref, not
                # merely the folded state at apply time
                if (
                    cause_payload.expected_state_ref is not None
                    and body.before_state_ref != cause_payload.expected_state_ref
                ):
                    errors.append(
                        f"envelope {env.seq}: apply before-state does not satisfy the "
                        "issued expected_state_ref"
                    )
        elif isinstance(body, ChangeReverted):
            new_ref, new_state = _replay(sub, state, state_ref, body, env, errors)
            state, state_ref = new_state, new_ref
            cid = body.change_id
            if cid not in applied_ids:
                errors.append(
                    f"envelope {env.seq}: revert of {cid!r} that was never applied"
                )
            if cid in reverted_ids:
                errors.append(f"envelope {env.seq}: duplicate revert of {cid!r}")
            reverted_ids.add(cid)
            revert_change = _decode_change(sub, body.revert_change_ref, env, errors)
            applied = applied_changes.get(cid)
            if revert_change is not None:
                _require_pinned_deltas(revert_change, bound, env, errors)
                if applied is not None and revert_change != applied.invert():
                    errors.append(
                        f"envelope {env.seq}: revert is not the EXACT inverse of the "
                        f"applied change {cid!r}"
                    )
            if cause_payload is not None:
                if cause_payload.target_change_id not in (None, cid):
                    errors.append(
                        f"envelope {env.seq}: revert targets {cid!r} but the command "
                        f"named {cause_payload.target_change_id!r}"
                    )
                if (
                    cause_payload.expected_state_ref is not None
                    and body.before_state_ref != cause_payload.expected_state_ref
                ):
                    errors.append(
                        f"envelope {env.seq}: revert before-state does not satisfy the "
                        "issued expected_state_ref"
                    )
        elif isinstance(body, PolicyCheckpointed):
            latest_checkpoint = body
            try:
                st = codec.loads(sub.objects.get_text(body.policy_state_ref), PolicyStateBlob)
                if st.encoding != ENCODING:
                    errors.append(
                        f"envelope {env.seq}: policy-state encoding {st.encoding!r} "
                        f"!= {ENCODING!r}"
                    )
                if not _canonical_json_ok(st.json):
                    errors.append(
                        f"envelope {env.seq}: policy-state json is malformed or noncanonical"
                    )
            except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
                errors.append(f"envelope {env.seq}: policy-state ref does not decode: {exc}")
            if body.state_ref != (state_ref or ""):
                errors.append(
                    f"envelope {env.seq}: checkpoint state_ref disagrees with the "
                    "folded state"
                )
            consumed = body.consumed_command_id
            if consumed is not None:
                if consumed not in completed:
                    errors.append(
                        f"envelope {env.seq}: checkpoint consumed {consumed!r} which "
                        "has no terminal result yet"
                    )
                if cause != consumed:
                    errors.append(
                        f"envelope {env.seq}: checkpoint must be caused by the command "
                        "it reduced"
                    )
                if consumed in consumed_cmds:
                    errors.append(
                        f"envelope {env.seq}: command {consumed!r} is consumed by more "
                        "than one checkpoint"
                    )
                consumed_cmds.add(consumed)
        elif isinstance(body, ObservationRecorded):
            _verify_observation(sub, body, env, cause_payload, proposals, errors)
        elif isinstance(body, ChangeProposed):
            if body.change_id in proposals:
                errors.append(
                    f"envelope {env.seq}: more than one proposal for change "
                    f"{body.change_id!r} (one proposal per change id)"
                )
            proposals.setdefault(body.change_id, body.change_ref)
            proposed = _decode_change(sub, body.change_ref, env, errors)
            if proposed is not None and proposed.change_id != body.change_id:
                errors.append(f"envelope {env.seq}: proposed change id/ref disagree")
            if cause_payload is not None and cause_payload.change_ref != body.change_ref:
                errors.append(
                    f"envelope {env.seq}: proposal does not match its command's target "
                    "change"
                )
        elif isinstance(body, ChangeConfirmed):
            if body.change_id not in proposals:
                errors.append(
                    f"envelope {env.seq}: confirm of change {body.change_id!r} that was "
                    "never proposed"
                )
            # TRUTHFUL CONFIRM: a confirm may only ratify a change that is
            # CURRENTLY in effect — applied, not reverted, and not superseded by
            # a later revision. Confirming an inactive change is a forged verdict.
            elif body.change_id not in applied_ids:
                errors.append(
                    f"envelope {env.seq}: confirm of change {body.change_id!r} that is "
                    "not applied"
                )
            elif body.change_id in reverted_ids:
                errors.append(
                    f"envelope {env.seq}: confirm of change {body.change_id!r} that was "
                    "already reverted"
                )
            elif body.change_id in superseded_ids:
                errors.append(
                    f"envelope {env.seq}: confirm of change {body.change_id!r} that was "
                    "superseded by a later revision"
                )
            if cause_payload is not None and cause_payload.target_change_id not in (
                None, body.change_id
            ):
                errors.append(
                    f"envelope {env.seq}: confirm targets {body.change_id!r} but the "
                    f"command named {cause_payload.target_change_id!r}"
                )
        elif isinstance(body, ChangeRevised):
            # TYPED old->new supersession lineage: `change_id` is the change being
            # retired; `new_change_ref` is the replacement. The retired change
            # must be CURRENTLY in effect (applied, not already reverted or
            # superseded), so a revision always retires a live change exactly once.
            if body.change_id not in applied_ids:
                errors.append(
                    f"envelope {env.seq}: revise of change {body.change_id!r} that is "
                    "not applied"
                )
            elif body.change_id in reverted_ids:
                errors.append(
                    f"envelope {env.seq}: revise of change {body.change_id!r} that was "
                    "already reverted"
                )
            elif body.change_id in superseded_ids:
                errors.append(
                    f"envelope {env.seq}: change {body.change_id!r} was already "
                    "superseded (double revision)"
                )
            else:
                superseded_ids.add(body.change_id)
            new_change = _decode_change(sub, body.new_change_ref, env, errors)
            if new_change is not None and new_change.change_id == body.change_id:
                errors.append(
                    f"envelope {env.seq}: revision's replacement reuses the retired "
                    f"change id {body.change_id!r}"
                )
        elif isinstance(body, OperationFailed):
            if body.command_id != cause:
                errors.append(
                    f"envelope {env.seq}: OperationFailed command_id must equal caused_by"
                )
            if body.outcome not in ("failed", "indeterminate"):
                errors.append(
                    f"envelope {env.seq}: OperationFailed outcome {body.outcome!r} "
                    "must be 'failed' or 'indeterminate'"
                )

    # the per-command CLOSED state machine: exact effect grammar per kind +
    # outcome, no effect after terminal, matching StoredResult, and a
    # well-formed fork-attempt lifecycle.
    _verify_command_lifecycles(
        sub, envelopes, bodies, bound, issued, completed, payloads, proposals,
        issue_states, errors,
    )

    # validate the FINAL folded state's surface content too (catches corruption
    # or preexisting-invalid content surviving into current state)
    if state_ref is not None:
        _verify_state(sub, state, "current state", errors, pinned)

    if errors:
        return fail(bound)
    return VerifiedSubstrateView(
        run_id=sub.run_id, task_id=sub.task_id, head=head, seq=len(envelopes),
        ok=True, errors=(), bound=bound, state=state, state_ref=state_ref,
        seed_state=seed_state, envelopes=tuple(envelopes), bodies=tuple(bodies),
        issued=MappingProxyType(dict(issued)),
        completed=MappingProxyType(dict(completed)),
        latest_checkpoint=latest_checkpoint,
        applied_change_ids=frozenset(applied_ids),
        reverted_change_ids=frozenset(reverted_ids),
        superseded_change_ids=frozenset(superseded_ids),
    )


def _load_pinned_snapshots(
    sub: Substrate, bound: PolicyBound, errors: list[str]
) -> dict[str, SurfaceDescriptorSnapshot]:
    pinned: dict[str, SurfaceDescriptorSnapshot] = {}
    for key, ref in bound.surface_descriptor_refs.items():
        try:
            snap = codec.loads(sub.objects.get_text(ref), SurfaceDescriptorSnapshot)
        except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
            errors.append(f"pinned surface descriptor {key!r} unreadable: {exc}")
            continue
        if f"{snap.kind}/{snap.name}" != key:
            errors.append(f"pinned surface descriptor {key!r} key/content disagree")
        pinned[key] = snap
    return pinned


def _decode_change(
    sub: Substrate, ref: str, env: EventEnvelope, errors: list[str]
) -> CompositeChange | None:
    try:
        return codec.loads(sub.objects.get_text(ref), CompositeChange)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        errors.append(f"envelope {env.seq}: change ref does not decode: {exc}")
        return None


def _reject_nonfinite(_token: str) -> object:
    raise ValueError("non-finite number (NaN/Infinity) is not canonical JSON")


def _canonical_json_ok(text: str) -> bool:
    """True iff `text` parses AND is the exact canonical serialization
    (sorted keys, tight separators). Rejects malformed OR noncanonical JSON,
    AND rejects NaN/Infinity — which `json` would otherwise round-trip — so no
    non-finite number can hide inside a canonical payload/config/state blob."""
    try:
        parsed = json.loads(text, parse_constant=_reject_nonfinite)
    except (ValueError, TypeError):
        return False
    try:
        canonical = json.dumps(
            parsed, sort_keys=True, separators=(",", ":"), allow_nan=False
        )
    except ValueError:
        return False
    return canonical == text


def _check_command_payload_coherence(
    sub: Substrate,
    env: EventEnvelope,
    payload: CommandPayload,
    errors: list[str],
) -> None:
    """A CommandPayload is ONE coherent intent. Its `encoding` is the supported
    version; exactly the right normalized anchors are present and non-null for
    its kind (every other normalized field FORBIDDEN); and its canonical JSON —
    re-derived here with the SAME `strict_encode` the kernel wrote — agrees
    EXACTLY with every normalized field. A missing anchor, an extra normalized
    field, an unexpected JSON key, or any normalized/JSON disagreement fails
    closed. This is the ONE place the two projections of intent are reconciled,
    so no effect can bind to a field the issued command did not actually name."""
    where = f"envelope {env.seq}: command payload"
    if payload.encoding != ENCODING:
        errors.append(
            f"{where} encoding {payload.encoding!r} != supported {ENCODING!r}"
        )
    spec = _PAYLOAD_SPECS.get(payload.kind)
    if spec is None:
        errors.append(f"{where} has unknown kind {payload.kind!r}")
        return
    required, optional, json_keys, change_key = spec
    # required (non-null) / optional / FORBIDDEN normalized anchors
    for name in _PAYLOAD_FIELDS:
        value = getattr(payload, name)
        if name in required:
            if value is None:
                errors.append(
                    f"{where} ({payload.kind}) is missing required anchor {name!r}"
                )
        elif name in optional:
            continue  # may be null or set
        elif value is not None:
            errors.append(
                f"{where} ({payload.kind}) carries forbidden field {name!r}"
            )
    # the canonical JSON must parse, be an object, and carry EXACTLY this kind's keys
    try:
        parsed = json.loads(payload.json)
    except (ValueError, TypeError):
        errors.append(f"{where} json is not parseable")
        return
    if not isinstance(parsed, dict):
        errors.append(f"{where} json is not an object")
        return
    if set(parsed.keys()) != json_keys:
        errors.append(
            f"{where} ({payload.kind}) json keys {sorted(parsed.keys())} != the "
            f"expected {sorted(json_keys)}"
        )
        return
    if parsed.get("command_id") != payload.command_id:
        errors.append(f"{where} json command_id disagrees with the normalized command_id")
    # the change-bearing kinds: target_change_id + change_ref must name EXACTLY
    # the change the JSON describes
    if change_key is not None:
        sub_json = parsed.get(change_key)
        if not isinstance(sub_json, dict) or sub_json.get("change_id") != payload.target_change_id:
            errors.append(
                f"{where} json {change_key} change_id disagrees with target_change_id"
            )
        if payload.change_ref is not None:
            try:
                change = codec.loads(
                    sub.objects.get_text(payload.change_ref), CompositeChange
                )
                if strict_encode(change) != sub_json:
                    errors.append(
                        f"{where} change_ref does not match the json {change_key} subtree"
                    )
            except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
                errors.append(f"{where} change_ref does not decode: {exc}")
    elif "change_id" in json_keys and parsed.get("change_id") != payload.target_change_id:
        errors.append(f"{where} json change_id disagrees with target_change_id")
    # the remaining scalar anchors that ARE carried verbatim in the JSON
    for name in (
        "expected_state_ref", "prompt_role", "context_ref", "after_seconds",
        "reason", "model_binding",
    ):
        if name in json_keys and parsed.get(name) != getattr(payload, name):
            errors.append(f"{where} json {name} disagrees with the normalized {name}")


def _usage_errors(usage: BudgetUsage, where: str) -> list[str]:
    """Every BudgetUsage dimension must be finite and nonnegative."""
    out: list[str] = []
    for name in (
        "wall_time_s", "executions", "model_calls", "tokens", "output_bytes",
        "cost", "recursion_depth",
    ):
        value = getattr(usage, name)
        if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
            out.append(f"{where}: {name} is not finite")
        if value < 0:
            out.append(f"{where}: {name} is negative ({value})")
    return out


def _effect_token(env: EventEnvelope, body: object) -> str:
    """The grammar token for one caused effect: an observation's kind for fork
    observations, else the body schema kind."""
    if isinstance(body, ObservationRecorded):
        return body.observation_kind
    return env.body_kind


def _verify_command_lifecycles(
    sub: Substrate,
    envelopes: list[EventEnvelope],
    bodies: list[object],
    bound: PolicyBound,
    issued: dict[str, PolicyCommandIssued],
    completed: dict[str, PolicyCommandCompleted],
    payloads: dict[str, CommandPayload],
    proposals: dict[str, str],
    issue_states: dict[str, str | None],
    errors: list[str],
) -> None:
    """The per-command CLOSED state machine: every command's caused events must
    form the exact grammar for its kind + outcome, with no effect before intent
    (already enforced) or after terminal, the right required/failure effects,
    a StoredResult that matches its effects, and a well-formed fork-attempt
    lifecycle."""
    caused: dict[str, list[tuple[EventEnvelope, object]]] = {}
    for env, body in zip(envelopes, bodies, strict=True):
        c = env.caused_by
        # a checkpoint is caused by the command it REDUCES and legitimately
        # follows that command's terminal — it is reduction bookkeeping (checked
        # in the main fold), not a command EFFECT, so exclude it from the
        # per-command effect grammar / effect-after-terminal check.
        if c is None or isinstance(body, (PolicyCommandIssued, PolicyCheckpointed)):
            continue
        caused.setdefault(c, []).append((env, body))

    for cid, issue in issued.items():
        events = caused.get(cid, [])
        _check_effect_after_terminal(cid, events, errors)
        _check_effect_after_failure(cid, events, errors)
        _check_fork_lifecycle(sub, cid, payloads.get(cid), events, bound, errors)
        _check_observation_lifecycle(
            sub, cid, events, bound, issue_states.get(cid), errors
        )
        _check_refinement_lifecycle(
            sub, cid, payloads.get(cid), events, bound, issue_states.get(cid), errors
        )
        terminal = completed.get(cid)
        _check_prefix_invariants(cid, events, terminal, errors)
        if terminal is not None:
            _check_command_grammar(
                sub, cid, issue.command_kind, terminal, events, errors
            )


def _check_observation_lifecycle(
    sub: Substrate,
    cid: str,
    events: list[tuple[EventEnvelope, object]],
    bound: PolicyBound,
    issue_state: str | None,
    errors: list[str],
) -> None:
    """An ObserveCurrentState is journaled crash-honestly like a fork attempt:
    a DISPATCH (subject-scoped to the ISSUE state, with a finite reservation)
    then a RESULT whose AttemptRecord is subject-scoped, carries the run's
    required capabilities and finite usage, and matches its ExecutionReport +
    Evaluation (label "current", generation "operation-current")."""
    dispatch: OperationDispatched | None = None
    dispatch_subject: str | None = None
    result: AttemptRecord | None = None
    result_subject: str | None = None
    dispatch_seq: int | None = None
    result_seq: int | None = None
    for env, body in events:
        if not isinstance(body, ObservationRecorded):
            continue
        try:
            if body.observation_kind == OPERATION_DISPATCH:
                dispatch = codec.loads(
                    sub.objects.get_text(body.observation_ref), OperationDispatched
                )
                dispatch_subject, dispatch_seq = body.subject_state_ref, env.seq
            elif body.observation_kind == OPERATION_RESULT:
                result = codec.loads(sub.objects.get_text(body.observation_ref), AttemptRecord)
                result_subject, result_seq = body.subject_state_ref, env.seq
        except (ObjectMissing, ObjectCorruption, codec.SchemaError):
            return  # the main fold reports the decode failure
    if dispatch is None and result is None:
        return  # not an operation command
    for what, subj in (("dispatch", dispatch_subject), ("result", result_subject)):
        if subj is not None and issue_state is not None and subj != issue_state:
            errors.append(f"command {cid!r}: operation {what} subject is not the issue state")
    if dispatch is not None:
        errors.extend(_usage_errors(
            BudgetUsage(
                executions=dispatch.reserved_executions,
                wall_time_s=dispatch.reserved_wall_s,
                output_bytes=dispatch.reserved_output_bytes,
            ),
            f"command {cid!r} operation reservation",
        ))
    if dispatch_seq is not None and result_seq is not None and dispatch_seq >= result_seq:
        errors.append(f"command {cid!r}: operation dispatch must precede its result")
    if result is not None:
        if result.label != OPERATION_LABEL:
            errors.append(f"command {cid!r}: operation result label {result.label!r}")
        missing = [
            cap for cap in bound.required_capabilities
            if cap not in result.provenance.enforced_capabilities
        ]
        if missing:
            errors.append(
                f"command {cid!r}: operation provenance lacks required "
                f"capabilities {missing}"
            )
        errors.extend(_usage_errors(result.usage, f"command {cid!r} operation usage"))
        _check_attempt_evidence(sub, cid, result, errors, gen_prefix="operation")


_KNOWN_FINISH = {"stop", "length", "error", "unknown"}


def _check_refinement_lifecycle(
    sub: Substrate,
    cid: str,
    payload: CommandPayload | None,
    events: list[tuple[EventEnvelope, object]],
    bound: PolicyBound,
    issue_state: str | None,
    errors: list[str],
) -> None:
    """Model lifecycle verification, parallel to forks: the binding/dispatch/
    result are subject-scoped to the ISSUE state; adapter+model agree across
    binding → dispatch → result; usage is finite and the finish reason known;
    the dispatch's prompt is EXACTLY control+active-template+context; and the
    stored proposal is EXACTLY the strict decode of the recorded response under
    the issued durable constraints — so a forged prompt/result/proposal linkage
    cannot pass."""
    binding: ModelBinding | None = None
    dispatch: ModelDispatch | None = None
    result: ModelResult | None = None
    subjects: dict[str, str] = {}
    for env, body in events:
        if not isinstance(body, ObservationRecorded):
            continue
        try:
            if body.observation_kind == REFINE_BINDING:
                binding = codec.loads(sub.objects.get_text(body.observation_ref), ModelBinding)
                subjects["binding"] = body.subject_state_ref
            elif body.observation_kind == REFINE_DISPATCH:
                dispatch = codec.loads(sub.objects.get_text(body.observation_ref), ModelDispatch)
                subjects["dispatch"] = body.subject_state_ref
            elif body.observation_kind == REFINE_RESULT:
                result = codec.loads(sub.objects.get_text(body.observation_ref), ModelResult)
                subjects["result"] = body.subject_state_ref
        except (ObjectMissing, ObjectCorruption, codec.SchemaError):
            return  # decode failures are reported by the main fold
    if binding is None and dispatch is None and result is None:
        return  # not a refinement command
    where = f"command {cid!r} refinement"
    # subject-scoped to the ISSUE state
    for what, subj in subjects.items():
        if issue_state is not None and subj != issue_state:
            errors.append(f"{where}: {what} subject is not the issue state")
    # adapter + model agree across binding → dispatch → result
    if binding is not None and dispatch is not None:
        if (dispatch.adapter_name, dispatch.model_id) != (binding.adapter_name, binding.model_id):
            errors.append(f"{where}: dispatch adapter/model disagrees with the binding")
    if dispatch is not None and result is not None:
        if result.adapter_name != dispatch.adapter_name:
            errors.append(f"{where}: result adapter disagrees with the dispatch")
    # finite usage + known finish reason
    if result is not None:
        errors.extend(_usage_errors(
            BudgetUsage(
                tokens=result.input_tokens + result.output_tokens,
                cost=result.cost, wall_time_s=result.latency_ms / 1000.0,
            ),
            f"{where} usage",
        ))
        if result.finish_reason not in _KNOWN_FINISH:
            errors.append(f"{where}: unknown finish_reason {result.finish_reason!r}")
    # the dispatch's prompt is EXACTLY control + active template + context
    if dispatch is not None and payload is not None:
        _check_refinement_prompt(sub, where, payload, bound, issue_state, dispatch, errors)
    # the stored proposal is EXACTLY the strict decode of the response
    if result is not None and result.failure is None and payload is not None:
        _check_refinement_proposal(sub, where, payload, bound, result, errors)


def _pinned_from_bound(
    sub: Substrate, bound: PolicyBound
) -> Callable[[str, str, str], None]:
    pinned = {
        key: codec.loads(sub.objects.get_text(ref), SurfaceDescriptorSnapshot)
        for key, ref in bound.surface_descriptor_refs.items()
    }

    def validate(kind: str, name: str, content: str) -> None:
        snap = pinned.get(f"{kind}/{name}")
        if snap is None:
            raise SurfaceValidationError(f"surface {(kind, name)} is not pinned")
        sub.catalog.resolve_pinned(snap).validator(content)

    return validate


def _check_refinement_prompt(
    sub: Substrate, where: str, payload: CommandPayload, bound: PolicyBound,
    issue_state: str | None, dispatch: ModelDispatch, errors: list[str],
) -> None:
    if payload.prompt_role is None or payload.context_ref is None or issue_state is None:
        return
    try:
        control_ref = bound.prompt_refs.get(payload.prompt_role)
        if control_ref is None:
            return
        control = sub.objects.get_text(control_ref)
        state = sub._load_state(issue_state)
        template_ref = state.content_ref("prompt", "proposal-template")
        if template_ref is None:
            return
        template = sub.objects.get_text(template_ref)
        blobs = json.loads(payload.json).get("content_blobs", {})
        if payload.context_ref not in blobs:
            errors.append(f"{where}: context_ref is not among the command's content_blobs")
            return
        context = sub.objects.get_text(payload.context_ref)
        expected = hash_text(render_prompt(control, template, context))
    except (ObjectMissing, ObjectCorruption, codec.SchemaError, SubstrateError, ValueError):
        return  # decode/state failures are reported elsewhere
    if dispatch.prompt_ref != expected:
        errors.append(
            f"{where}: dispatch prompt_ref is not control+active-template+context"
        )


def _check_refinement_proposal(
    sub: Substrate, where: str, payload: CommandPayload, bound: PolicyBound,
    result: ModelResult, errors: list[str],
) -> None:
    if result.response_ref is None or result.proposal_ref is None:
        errors.append(f"{where}: an ok result must carry a response and a proposal")
        return
    try:
        response = sub.objects.get_text(result.response_ref)
        stored = codec.loads(sub.objects.get_text(result.proposal_ref), RefinementProposal)
        spec = json.loads(payload.json)
        enabled = frozenset(
            (s.split("/", 1)[0], s.split("/", 1)[1])
            for s in spec.get("enabled_surfaces", [])
            if "/" in s
        )
        redecoded, _blobs = decode_proposal(
            response,
            validate=_pinned_from_bound(sub, bound),
            enabled_surfaces=enabled,
            required_change_id=spec.get("required_change_id", ""),
            edit_limit=spec.get("edit_limit", 0),
            edit_rule=spec.get("edit_rule", ""),
        )
    except RefinementDecodeError:
        errors.append(f"{where}: stored proposal but the response does not strictly decode")
        return
    except (ObjectMissing, ObjectCorruption, codec.SchemaError, ValueError):
        return  # reported elsewhere
    if redecoded != stored:
        errors.append(f"{where}: stored proposal != the strict decode of the response")


def _check_prefix_invariants(
    cid: str,
    events: list[tuple[EventEnvelope, object]],
    terminal: PolicyCommandCompleted | None,
    errors: list[str],
) -> None:
    """Legal PARTIAL prefixes (even before a terminal): a command accumulates at
    most one failure record and at most one of each success effect, and a
    terminal's outcome must equal any recorded failure's outcome (so a crash
    after the failure reconciles to the SAME outcome)."""
    tokens = [
        _effect_token(env, body)
        for env, body in events
        if not isinstance(body, PolicyCommandCompleted)
    ]
    counts = Counter(tokens)
    if counts.get("operation-failed@3", 0) > 1:
        errors.append(f"command {cid!r}: more than one failure record")
    for token in _SUCCESS_TOKENS:
        if counts.get(token, 0) > 1:
            errors.append(f"command {cid!r}: duplicate success effect {token!r}")
    failures = [b for _e, b in events if isinstance(b, OperationFailed)]
    if failures and terminal is not None and failures[0].outcome != terminal.outcome:
        errors.append(
            f"command {cid!r}: terminal outcome {terminal.outcome!r} disagrees with "
            f"its failure record outcome {failures[0].outcome!r}"
        )


def _check_effect_after_terminal(
    cid: str, events: list[tuple[EventEnvelope, object]], errors: list[str]
) -> None:
    term_seq: int | None = None
    for env, body in events:
        if isinstance(body, PolicyCommandCompleted):
            term_seq = env.seq
    if term_seq is None:
        return
    for env, body in events:
        if isinstance(body, PolicyCommandCompleted):
            continue
        if env.seq > term_seq:
            errors.append(
                f"command {cid!r}: effect {env.body_kind} at #{env.seq} appears "
                "AFTER its terminal completion"
            )


def _check_effect_after_failure(
    cid: str, events: list[tuple[EventEnvelope, object]], errors: list[str]
) -> None:
    """Once a command's failure is durably recorded, the ONLY event it may cause
    afterward is its matching terminal completion (a checkpoint is reduction
    bookkeeping, already excluded from `events`). No success effect, observation,
    or second failure may follow — the command is frozen at its failure."""
    fail_seq: int | None = None
    for env, body in events:
        if isinstance(body, OperationFailed):
            fail_seq = env.seq if fail_seq is None else min(fail_seq, env.seq)
    if fail_seq is None:
        return
    for env, body in events:
        if env.seq <= fail_seq or isinstance(body, PolicyCommandCompleted):
            continue
        errors.append(
            f"command {cid!r}: effect {env.body_kind} at #{env.seq} appears AFTER "
            "its failure was recorded"
        )


def _reconciled_usage_from_events(
    sub: Substrate, events: list[tuple[EventEnvelope, object]]
) -> BudgetUsage:
    """The usage a command's DURABLE ledger accounts for: each completed fork
    attempt's actual usage OR each completed model call's usage, plus each OPEN
    dispatch's worst-case reservation — exactly the kernel's `_reconciled_usage`
    (both call `combine_usage`). A command is either a fork or a refinement, so
    the two ledgers never overlap for one command."""
    results: dict[str, BudgetUsage] = {}
    dispatched: dict[str, AttemptDispatched | OperationDispatched] = {}
    model_results: list[ModelResult] = []
    model_dispatches: list[ModelDispatch] = []
    for env, body in events:
        if not isinstance(body, ObservationRecorded):
            continue
        try:
            if body.observation_kind in (FORK_RESULT, OPERATION_RESULT):
                rec = codec.loads(sub.objects.get_text(body.observation_ref), AttemptRecord)
                results[rec.label] = rec.usage
            elif body.observation_kind == FORK_DISPATCH:
                disp = codec.loads(
                    sub.objects.get_text(body.observation_ref), AttemptDispatched
                )
                dispatched[disp.label] = disp
            elif body.observation_kind == OPERATION_DISPATCH:
                odisp = codec.loads(
                    sub.objects.get_text(body.observation_ref), OperationDispatched
                )
                dispatched[OPERATION_LABEL] = odisp
            elif body.observation_kind == REFINE_RESULT:
                model_results.append(
                    codec.loads(sub.objects.get_text(body.observation_ref), ModelResult)
                )
            elif body.observation_kind == REFINE_DISPATCH:
                model_dispatches.append(
                    codec.loads(sub.objects.get_text(body.observation_ref), ModelDispatch)
                )
        except (ObjectMissing, ObjectCorruption, codec.SchemaError):
            continue  # decode failures are reported by the lifecycle checks
    usages = list(results.values())
    for label, open_disp in dispatched.items():
        if label not in results:
            usages.append(BudgetUsage(
                executions=open_disp.reserved_executions,
                wall_time_s=open_disp.reserved_wall_s,
                output_bytes=open_disp.reserved_output_bytes,
            ))
    # a completed model call charges its actual usage; an OPEN model dispatch
    # (no result) reserves the worst case — a result overrides its dispatch.
    if model_results:
        usages.extend(model_result_usage(r) for r in model_results)
    else:
        usages.extend(model_dispatch_reservation(d) for d in model_dispatches)
    return combine_usage(usages)


def _check_command_grammar(
    sub: Substrate,
    cid: str,
    kind: str,
    terminal: PolicyCommandCompleted,
    events: list[tuple[EventEnvelope, object]],
    errors: list[str],
) -> None:
    tokens = [
        _effect_token(env, body)
        for env, body in events
        if not isinstance(body, PolicyCommandCompleted)
    ]
    if terminal.outcome == "ok":
        if terminal.result_ref is None:
            errors.append(f"command {cid!r}: a successful terminal has no StoredResult")
        required = _OK_EFFECTS.get(kind)
        if required is None:
            errors.append(f"command {cid!r}: kind {kind!r} cannot succeed")
            return
        mandatory = Counter(t for t in tokens if t not in _OPTIONAL_OK_EFFECTS)
        optional = Counter(t for t in tokens if t in _OPTIONAL_OK_EFFECTS)
        if mandatory != Counter(required):
            errors.append(
                f"command {cid!r} ({kind} ok): effects {dict(mandatory)} do not "
                f"equal the required grammar {required}"
            )
        if any(count > 1 for count in optional.values()):
            errors.append(f"command {cid!r}: duplicate optional (proposal) effect")
        # ordering: a proposal (if present) comes first; a fork summary is last
        non_terminal = tokens
        if "change-proposed@2" in non_terminal and non_terminal[0] != "change-proposed@2":
            errors.append(f"command {cid!r}: proposal must precede its command's effects")
        if kind == "EvaluateFork" and non_terminal and non_terminal[-1] != "fork-evaluation":
            errors.append(f"command {cid!r}: fork summary must be the last effect")
        if kind == "RequestRefinement":
            order = [REFINE_BINDING, REFINE_DISPATCH, REFINE_RESULT]
            present = [t for t in order if t in non_terminal]
            positions = [non_terminal.index(t) for t in present]
            if positions != sorted(positions):
                errors.append(
                    f"command {cid!r}: model binding → dispatch → result must be ordered"
                )
        if (
            kind == "ObserveCurrentState"
            and OPERATION_DISPATCH in non_terminal
            and OPERATION_RESULT in non_terminal
            and non_terminal.index(OPERATION_DISPATCH) > non_terminal.index(OPERATION_RESULT)
        ):
            errors.append(
                f"command {cid!r}: operation dispatch must precede the operation result"
            )
        _check_stored_result(sub, cid, kind, terminal, events, errors)
    else:  # failed | indeterminate: a failure record and NO success effect
        counts = Counter(tokens)
        if counts.get("operation-failed@3", 0) != 1:
            errors.append(
                f"command {cid!r} ({terminal.outcome}): needs exactly one failure record"
            )
        for token in _SUCCESS_TOKENS:
            if counts.get(token, 0):
                errors.append(
                    f"command {cid!r} ({terminal.outcome}): has a success effect "
                    f"{token!r}"
                )
        _check_stored_result(sub, cid, kind, terminal, events, errors)


def _check_stored_result(
    sub: Substrate,
    cid: str,
    kind: str,
    terminal: PolicyCommandCompleted,
    events: list[tuple[EventEnvelope, object]],
    errors: list[str],
) -> None:
    """Verify EVERY terminal's StoredResult identically: it exists, decodes,
    carries finite/nonnegative usage, and its detail / proposal & observation
    refs / metrics / usage match the command's ACTUAL effects. A non-ok terminal
    is held to the mirror rule (no proposal/observation/metrics; its detail is
    the failure record's detail; its usage is the reconciled attempt ledger)."""
    if terminal.result_ref is None:
        return
    try:
        stored = codec.loads(sub.objects.get_text(terminal.result_ref), StoredResult)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError):
        return  # the main fold already reported the decode failure
    errors.extend(_usage_errors(stored.usage, f"command {cid!r} StoredResult.usage"))
    if terminal.outcome != "ok":
        _check_failed_stored_result(sub, cid, stored, terminal, events, errors)
        return
    applied_ref: str | None = None
    summary_event_ref: str | None = None  # the ObservationRecorded event body ref
    summary_inner_ref: str | None = None  # the inner ForkObservation ref
    refine_result_ref: str | None = None  # the REFINE_RESULT event body ref
    observe_result_ref: str | None = None  # the OPERATION_RESULT event body ref
    for env, body in events:
        if isinstance(body, ChangeApplied):
            applied_ref = body.change_ref
        elif isinstance(body, ObservationRecorded) and body.observation_kind == FORK_SUMMARY:
            summary_event_ref = env.body_ref
            summary_inner_ref = body.observation_ref
        elif isinstance(body, ObservationRecorded) and body.observation_kind == REFINE_RESULT:
            refine_result_ref = env.body_ref
        elif isinstance(body, ObservationRecorded) and body.observation_kind == OPERATION_RESULT:
            observe_result_ref = env.body_ref
    expected_proposal = applied_ref if kind == "ApplyChange" else None
    if stored.proposal_ref != expected_proposal:
        errors.append(
            f"command {cid!r}: StoredResult.proposal_ref does not match the "
            "command's actual proposal/apply effect"
        )
    if kind == "EvaluateFork":
        if stored.observation_ref != summary_event_ref:
            errors.append(
                f"command {cid!r}: StoredResult.observation_ref does not match the "
                "fork summary event"
            )
        if summary_inner_ref is not None:
            try:
                fork = codec.loads(sub.objects.get_text(summary_inner_ref), ForkObservation)
                expected = {
                    "base_overall": fork.base_overall,
                    "candidate_overall": fork.candidate_overall,
                    "improved": 1.0 if fork.improved else 0.0,
                }
                if stored.metrics != expected:
                    errors.append(
                        f"command {cid!r}: StoredResult.metrics do not match the fork "
                        "summary"
                    )
            except (ObjectMissing, ObjectCorruption, codec.SchemaError):
                pass
    elif kind == "RequestRefinement":
        # a refinement's result points at its model-result event; it carries no
        # metrics; its usage is the reconciled model-call ledger
        if stored.observation_ref != refine_result_ref:
            errors.append(
                f"command {cid!r}: StoredResult.observation_ref does not match the "
                "model result event"
            )
        if stored.metrics:
            errors.append(f"command {cid!r}: StoredResult.metrics on a refinement")
    elif kind == "ObserveCurrentState":
        # an observation's result points at its state-observation event; no
        # metrics; its usage is the reconciled execution ledger
        if stored.observation_ref != observe_result_ref:
            errors.append(
                f"command {cid!r}: StoredResult.observation_ref does not match the "
                "state observation event"
            )
        if stored.metrics:
            errors.append(f"command {cid!r}: StoredResult.metrics on an observation")
    else:
        if stored.observation_ref is not None:
            errors.append(f"command {cid!r}: StoredResult.observation_ref on a non-fork")
        if stored.metrics:
            errors.append(f"command {cid!r}: StoredResult.metrics on a non-fork")
    # an OK terminal's usage equals the reconciled ledger for a fork, refinement,
    # or observation; any other OK command spends nothing.
    if kind in ("EvaluateFork", "RequestRefinement", "ObserveCurrentState"):
        expected_usage = _reconciled_usage_from_events(sub, events)
        if stored.usage != expected_usage:
            errors.append(
                f"command {cid!r}: StoredResult.usage does not equal the reconciled "
                "ledger"
            )
    elif stored.usage != BudgetUsage():
        errors.append(
            f"command {cid!r}: StoredResult.usage on a non-fork ok terminal is nonzero"
        )


def _check_failed_stored_result(
    sub: Substrate,
    cid: str,
    stored: StoredResult,
    terminal: PolicyCommandCompleted,
    events: list[tuple[EventEnvelope, object]],
    errors: list[str],
) -> None:
    """A failed/indeterminate terminal's StoredResult mirrors its failure: NO
    proposal, observation, or metrics; its detail is the recorded failure's
    detail; and its usage is the reconciled attempt ledger — the honest cost of
    a crashed partial fork, never zero and never re-run."""
    if stored.proposal_ref is not None:
        errors.append(f"command {cid!r} ({terminal.outcome}): StoredResult has a proposal_ref")
    if stored.observation_ref is not None:
        errors.append(
            f"command {cid!r} ({terminal.outcome}): StoredResult has an observation_ref"
        )
    if stored.metrics:
        errors.append(f"command {cid!r} ({terminal.outcome}): StoredResult has metrics")
    failures = [b for _e, b in events if isinstance(b, OperationFailed)]
    if failures and stored.detail != failures[0].detail:
        errors.append(
            f"command {cid!r} ({terminal.outcome}): StoredResult.detail does not match "
            "the recorded failure detail"
        )
    expected_usage = _reconciled_usage_from_events(sub, events)
    if stored.usage != expected_usage:
        errors.append(
            f"command {cid!r} ({terminal.outcome}): StoredResult.usage does not equal "
            "the reconciled attempt ledger"
        )


def _fork_expected_states(
    sub: Substrate, payload: CommandPayload | None
) -> dict[str, str] | None:
    """Derive the EXACT states a fork's attempts must use, ANCHORED to the
    issued command: base == the state ref recorded at issue; candidate ==
    applying the issued candidate change to that base. Returns None when the
    anchor cannot be reconstructed (a separate error is already reported)."""
    if payload is None or payload.issue_state_ref is None or payload.change_ref is None:
        return None
    try:
        base_state = sub._load_state(payload.issue_state_ref)
        candidate = codec.loads(sub.objects.get_text(payload.change_ref), CompositeChange)
        candidate_state = apply_change(base_state, candidate, sub.catalog)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError, SubstrateError):
        return None
    return {
        "base": payload.issue_state_ref,
        "candidate": hash_text(codec.dumps(candidate_state)),
    }


def _check_attempt_evidence(
    sub: Substrate, cid: str, rec: AttemptRecord, errors: list[str],
    *, gen_prefix: str = "fork",
) -> None:
    """Bind an AttemptRecord to the EXACT evidence it references: its `overall`
    equals the referenced Evaluation's score; its `ok`/`failure` agree with the
    referenced ExecutionReport (and with each other); the report's identity is
    this attempt's label (under `gen_prefix`: `fork`/`observe`); and its
    output/wall usage is consistent with the report. So the score policy later
    uses is the one the retained evidence actually supports — never an asserted
    number floating free of its report."""
    where = f"command {cid!r}: {rec.label!r}"
    try:
        report = codec.loads(sub.objects.get_text(rec.report_ref), ExecutionReport)
        evaluation = codec.loads(sub.objects.get_text(rec.evaluation_ref), Evaluation)
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        errors.append(f"{where} execution evidence does not decode: {exc}")
        return
    # the score is EXACTLY the referenced evaluation's overall
    if rec.overall != evaluation.overall_score:
        errors.append(f"{where} overall != the referenced Evaluation.overall_score")
    # ok/failure agree with the report AND are internally consistent
    if rec.ok != report.ok:
        errors.append(f"{where} ok != the referenced ExecutionReport.ok")
    if rec.failure != report.failure:
        errors.append(f"{where} failure != the referenced ExecutionReport.failure")
    if rec.ok != (rec.failure is None):
        errors.append(f"{where} ok disagrees with whether a failure is present")
    # the evaluation mirrors the report's failure (floored iff the report failed)
    if evaluation.failure != report.failure:
        errors.append(f"{where} Evaluation.failure != ExecutionReport.failure")
    # the report's identity is this attempt's label
    if report.generation_id != f"{gen_prefix}-{rec.label}":
        errors.append(f"{where} ExecutionReport.generation_id is not this attempt's label")
    # output/wall accounting is consistent with the report: exact captured bytes,
    # and an attempt's real wall is at least the aggregated backend wall it spans
    if rec.usage.output_bytes != report.stdout_bytes:
        errors.append(f"{where} usage.output_bytes != ExecutionReport.stdout_bytes")
    if rec.usage.wall_time_s + 1e-3 < report.wall_time_s:
        errors.append(f"{where} usage.wall_time_s is below the report's backend wall")


def _check_fork_lifecycle(
    sub: Substrate,
    cid: str,
    payload: CommandPayload | None,
    events: list[tuple[EventEnvelope, object]],
    bound: PolicyBound,
    errors: list[str],
) -> None:
    expected = _fork_expected_states(sub, payload)  # base/candidate anchored to issue
    dispatches: dict[str, AttemptDispatched] = {}
    dispatch_seq: dict[str, int] = {}
    results: dict[str, AttemptRecord] = {}
    for env, body in events:  # events are in seq order
        if not isinstance(body, ObservationRecorded):
            continue
        if body.observation_kind == FORK_DISPATCH:
            try:
                disp = codec.loads(sub.objects.get_text(body.observation_ref), AttemptDispatched)
            except (ObjectMissing, ObjectCorruption, codec.SchemaError):
                continue
            if disp.label in dispatches:
                errors.append(f"command {cid!r}: duplicate {disp.label!r} dispatch")
            dispatches[disp.label] = disp
            dispatch_seq.setdefault(disp.label, env.seq)
            if disp.state_ref != body.subject_state_ref:
                errors.append(
                    f"command {cid!r}: dispatch state_ref != subject_state_ref"
                )
            if expected is not None and disp.state_ref != expected.get(disp.label):
                errors.append(
                    f"command {cid!r}: {disp.label!r} dispatch state is not the "
                    "issued base/candidate state"
                )
            errors.extend(_usage_errors(
                BudgetUsage(
                    wall_time_s=disp.reserved_wall_s,
                    executions=disp.reserved_executions,
                    output_bytes=disp.reserved_output_bytes,
                ),
                f"command {cid!r} {disp.label} reservation",
            ))
        elif body.observation_kind == FORK_RESULT:
            try:
                rec = codec.loads(sub.objects.get_text(body.observation_ref), AttemptRecord)
            except (ObjectMissing, ObjectCorruption, codec.SchemaError):
                continue
            if rec.label not in dispatches:
                errors.append(f"command {cid!r}: {rec.label!r} result without a dispatch")
            if rec.label in results:
                errors.append(f"command {cid!r}: duplicate {rec.label!r} result")
            results[rec.label] = rec
            if rec.state_ref != body.subject_state_ref:
                errors.append(f"command {cid!r}: result state_ref != subject_state_ref")
            matched = dispatches.get(rec.label)
            if matched is not None and matched.state_ref != rec.state_ref:
                errors.append(
                    f"command {cid!r}: {rec.label!r} result does not match its dispatch"
                )
            if expected is not None and rec.state_ref != expected.get(rec.label):
                errors.append(
                    f"command {cid!r}: {rec.label!r} result state is not the issued "
                    "base/candidate state"
                )
            missing = [
                cap for cap in bound.required_capabilities
                if cap not in rec.provenance.enforced_capabilities
            ]
            if missing:
                errors.append(
                    f"command {cid!r}: {rec.label!r} provenance lacks required "
                    f"capabilities {missing}"
                )
            errors.extend(_usage_errors(rec.usage, f"command {cid!r} {rec.label} usage"))
            _check_attempt_evidence(sub, cid, rec, errors)
        elif body.observation_kind == FORK_SUMMARY:
            try:
                summary = codec.loads(sub.objects.get_text(body.observation_ref), ForkObservation)
            except (ObjectMissing, ObjectCorruption, codec.SchemaError):
                continue
            for label in ("base", "candidate"):
                durable = results.get(label)
                summ = summary.base if label == "base" else summary.candidate
                if durable is None or summ != durable:
                    errors.append(
                        f"command {cid!r}: fork summary {label} != the durable "
                        f"{label} result record"
                    )
            # the summary event subject must equal the candidate state
            if expected is not None and body.subject_state_ref != expected.get("candidate"):
                errors.append(
                    f"command {cid!r}: fork summary subject is not the candidate state"
                )
            # recompute `improved` — it is derived, never asserted
            if summary.improved != (summary.candidate.overall > summary.base.overall):
                errors.append(
                    f"command {cid!r}: fork summary `improved` disagrees with the "
                    "recomputed comparison"
                )
            if payload is not None and payload.change_ref is not None:
                try:
                    change = codec.loads(
                        sub.objects.get_text(payload.change_ref), CompositeChange
                    )
                    if change.change_id != summary.candidate_change_id:
                        errors.append(
                            f"command {cid!r}: fork summary candidate does not equal "
                            "the issued candidate change"
                        )
                except (ObjectMissing, ObjectCorruption, codec.SchemaError):
                    pass  # the main fold reports payload/ref decode failures
    if "base" in dispatch_seq and "candidate" in dispatch_seq:
        if dispatch_seq["base"] >= dispatch_seq["candidate"]:
            errors.append(f"command {cid!r}: base must be dispatched before candidate")


def _require_pinned_deltas(
    change: CompositeChange, bound: PolicyBound, env: EventEnvelope, errors: list[str]
) -> None:
    """A run may only mutate surfaces PINNED in its PolicyBound — adding a
    surface to the live catalog is not enough (that needs a rebind/new run)."""
    for delta in change.deltas:
        if f"{delta.kind}/{delta.name}" not in bound.surface_descriptor_refs:
            errors.append(
                f"envelope {env.seq}: change touches surface "
                f"{(delta.kind, delta.name)} not pinned in this run"
            )


def _verify_observation(
    sub: Substrate,
    body: ObservationRecorded,
    env: EventEnvelope,
    cause_payload: CommandPayload | None,
    proposals: dict[str, str],
    errors: list[str],
) -> None:
    """Decode a fork observation as its EXPECTED typed body (dispatch / result /
    summary) and cross-check its scope against the causing command."""
    for ref, what in [
        (body.subject_state_ref, "subject state"),
        (body.observation_ref, "observation body"),
    ]:
        if ref:
            try:
                sub.objects.get_text(ref)  # hash-verify presence + UTF-8
            except (ObjectMissing, ObjectCorruption) as exc:
                errors.append(f"envelope {env.seq}: {what} unreadable: {exc}")
    cause = env.caused_by
    try:
        if body.observation_kind == FORK_DISPATCH:
            disp = codec.loads(sub.objects.get_text(body.observation_ref), AttemptDispatched)
            if disp.command_id != cause:
                errors.append(f"envelope {env.seq}: attempt dispatch command_id disagrees")
            if disp.label not in ("base", "candidate"):
                errors.append(f"envelope {env.seq}: unknown attempt label {disp.label!r}")
        elif body.observation_kind == FORK_RESULT:
            rec = codec.loads(sub.objects.get_text(body.observation_ref), AttemptRecord)
            if rec.command_id != cause:
                errors.append(f"envelope {env.seq}: attempt result command_id disagrees")
            if rec.label not in ("base", "candidate"):
                errors.append(f"envelope {env.seq}: unknown attempt label {rec.label!r}")
        elif body.observation_kind == FORK_SUMMARY:
            fork = codec.loads(sub.objects.get_text(body.observation_ref), ForkObservation)
            if cause_payload is not None and proposals.get(
                fork.candidate_change_id
            ) != cause_payload.change_ref:
                errors.append(
                    f"envelope {env.seq}: fork candidate does not match the proposed / "
                    "issued change"
                )
        elif body.observation_kind == OPERATION_DISPATCH:
            odisp = codec.loads(sub.objects.get_text(body.observation_ref), OperationDispatched)
            if odisp.command_id != cause:
                errors.append(f"envelope {env.seq}: operation dispatch command_id disagrees")
        elif body.observation_kind == OPERATION_RESULT:
            obs = codec.loads(sub.objects.get_text(body.observation_ref), AttemptRecord)
            if obs.command_id != cause:
                errors.append(f"envelope {env.seq}: operation result command_id disagrees")
            if obs.label != OPERATION_LABEL:
                errors.append(
                    f"envelope {env.seq}: operation label {obs.label!r} != "
                    f"{OPERATION_LABEL!r}"
                )
        elif body.observation_kind == REFINE_BINDING:
            binding = codec.loads(sub.objects.get_text(body.observation_ref), ModelBinding)
            if binding.command_id != cause:
                errors.append(f"envelope {env.seq}: model binding command_id disagrees")
        elif body.observation_kind == REFINE_DISPATCH:
            mdisp = codec.loads(sub.objects.get_text(body.observation_ref), ModelDispatch)
            if mdisp.command_id != cause:
                errors.append(f"envelope {env.seq}: model dispatch command_id disagrees")
        elif body.observation_kind == REFINE_RESULT:
            res = codec.loads(sub.objects.get_text(body.observation_ref), ModelResult)
            if res.command_id != cause:
                errors.append(f"envelope {env.seq}: model result command_id disagrees")
            # a successful result carries a decoded proposal; a failed one a
            # failure — never both, never neither
            if (res.proposal_ref is None) == (res.failure is None):
                errors.append(
                    f"envelope {env.seq}: model result must carry exactly one of "
                    "a proposal (ok) or a failure"
                )
        else:
            errors.append(
                f"envelope {env.seq}: unknown observation_kind {body.observation_kind!r}"
            )
    except (ObjectMissing, ObjectCorruption, codec.SchemaError) as exc:
        errors.append(f"envelope {env.seq}: observation body does not decode: {exc}")


def _validate_surface_content(
    sub: Substrate,
    pinned: dict[str, SurfaceDescriptorSnapshot],
    kind: str,
    name: str,
    content_ref: str,
    what: str,
    errors: list[str],
) -> None:
    try:
        content = sub.objects.get_text(content_ref)  # hash-verify + UTF-8
    except (ObjectMissing, ObjectCorruption) as exc:
        errors.append(f"{what} binding {(kind, name)} content unreadable: {exc}")
        return
    snap = pinned.get(f"{kind}/{name}")
    if snap is None:
        errors.append(f"{what} binding {(kind, name)} has no pinned surface descriptor")
        return
    try:
        descriptor = sub.catalog.resolve_pinned(snap)  # refuses validator drift
        descriptor.validator(content)
    except SurfaceValidationError as exc:
        errors.append(f"{what} binding {(kind, name)} invalid: {exc}")


def _verify_state(
    sub: Substrate,
    state: HarnessState,
    what: str,
    errors: list[str],
    pinned: dict[str, SurfaceDescriptorSnapshot],
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
        if not sub.catalog.allows(*key):
            errors.append(f"{what} binding {key} is not in the surface catalog")
        # decode + hash-verify + structurally validate content (even if shared)
        _validate_surface_content(
            sub, pinned, binding.kind, binding.name, binding.content_ref, what, errors
        )


def _replay(
    sub: Substrate,
    state: HarnessState,
    state_ref: str | None,
    body: object,
    env: EventEnvelope,
    errors: list[str],
) -> tuple[str, HarnessState]:
    """PURE replay: recompute the expected after-state ref WITHOUT publishing
    anything to CAS (verify must never write)."""
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
        recomputed = apply_change(state, change, sub.catalog)
        recomputed_ref = hash_text(codec.dumps(recomputed))  # pure: no put
    except (ObjectMissing, ObjectCorruption, codec.SchemaError, SubstrateError) as exc:
        errors.append(f"envelope {env.seq}: change does not replay: {exc}")
        return body.after_state_ref, state
    if recomputed_ref != body.after_state_ref:
        errors.append(
            f"envelope {env.seq}: deterministic application does not equal "
            "the recorded after_state_ref"
        )
    elif not sub.objects.has(body.after_state_ref, verify=True):
        errors.append(
            f"envelope {env.seq}: recorded after-state object missing/corrupt in CAS"
        )
    return body.after_state_ref, recomputed


__all__ = [
    "EMPTY_STATE",
    "SUBSTRATE_STREAM",
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
    "RunBinding",
    "Substrate",
    "SubstrateError",
    "SurfaceBinding",
    "SurfaceDelta",
    "VerifiedSubstrateView",
    "apply_change",
    "canonical_state",
    "new_run_id",
    "validate_change",
    "validate_run_id",
]
