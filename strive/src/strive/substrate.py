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

import os
import re
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Mapping

from strive import codec
from strive.cas import ObjectCorruption, ObjectMissing, ObjectStore, hash_text
from strive.codec import register
from strive.events import now_iso
from strive.framing import FramedJournal, FramingError
from strive.surfaces import (
    SurfaceCatalog,
    SurfaceValidationError,
    default_surface_catalog,
)

SUBSTRATE_STREAM = "strive-substrate@3"

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


def validate_change(change: CompositeChange, catalog: SurfaceCatalog | None = None) -> None:
    cat = catalog or default_surface_catalog()
    seen: set[tuple[str, str]] = set()
    if not change.deltas:
        raise SubstrateError("a change must carry at least one delta")
    for delta in change.deltas:
        key = (delta.kind, delta.name)
        if not cat.allows(*key):
            raise SubstrateError(
                f"surface {key} is not in the surface catalog "
                f"(allowed: {sorted(cat.keys())})"
            )
        if key in seen:
            raise SubstrateError(f"duplicate delta for surface {key}")
        seen.add(key)
        if delta.before_ref == delta.after_ref:
            raise SubstrateError(f"no-op delta for surface {key}")


def apply_change(
    state: HarnessState, change: CompositeChange, catalog: SurfaceCatalog | None = None
) -> HarnessState:
    """Apply a change EXACTLY: every `before_ref` must equal the surface's
    current content (a stale before is a conflict); `after_ref=None` removes
    it. Returns the new canonical state."""
    validate_change(change, catalog)
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


@register("policy-bound", 3)
@dataclass(frozen=True)
class PolicyBound:
    """AUTHORITY + identity. Pins EVERYTHING that defines this run: the task
    id and its spec fingerprint, the policy implementation ref + package
    digest, the exact frozen config, versioned prompt refs, seed, the SEED
    composite state, the pinned budget spec, the required sandbox/semantic
    capability profile, and the surface catalog digest. Model/provider is
    `run_metadata` (reproducibility), NOT identity."""

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
    surface_catalog_digest: str
    run_metadata: dict[str, str]


@register("run-binding", 1)
@dataclass(frozen=True)
class RunBinding:
    """The discovery index mirror of `PolicyBound`, persisted at
    ``<root>/runs/<run_id>.binding.json``. Lets a tool learn a run's task
    WITHOUT string-parsing the run id, and is cross-checked against the
    authoritative in-stream `PolicyBound` on every verify."""

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
    surface_catalog_digest: str

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
            surface_catalog_digest=bound.surface_catalog_digest,
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
        binding index (never from parsing the run id)."""
        validate_run_id(run_id)
        binding = _read_binding(root, run_id)
        if binding is not None:
            return Substrate.open(root, binding.task_id, run_id, catalog=catalog)
        # no binding yet: peek the stream's first envelope for scope
        sub = Substrate.open(root, "", run_id, catalog=catalog)
        framed = sub.journal.read()
        for entry in framed.entries:
            assert isinstance(entry, EventEnvelope)
            return Substrate.open(root, entry.task_id, run_id, catalog=catalog)
        raise SubstrateError(
            f"cannot discover task for run {run_id!r}: no binding index and an "
            "empty stream"
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

    def _binding_path(self) -> Path:
        return self.root / "runs" / f"{self.run_id}.binding.json"

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
            surface_catalog_digest=self.catalog.descriptor_digest(),
            run_metadata=dict(run_metadata),
        )
        updated = self._emit(record, caused_by=None, view=view)
        # persist the discovery index AFTER the authoritative event exists
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
        blob hashes to the ref the change points at AND passes the surface's
        trusted structural validator. Full closure is required before apply."""
        validate_change(change, self.catalog)
        after_surface = {
            d.after_ref: (d.kind, d.name)
            for d in change.deltas
            if d.after_ref is not None
        }
        needed = change.referenced_refs()
        for ref, content in blobs.items():
            if hash_text(content) != ref:
                raise SubstrateError(
                    f"staged content does not hash to its ref {ref[:12]}…"
                )
            if ref in after_surface:
                kind, name = after_surface[ref]
                try:
                    self.catalog.validate_content(kind, name, content)
                except SurfaceValidationError as exc:
                    raise SubstrateError(
                        f"staged content for {(kind, name)} is invalid: {exc}"
                    ) from None
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
        validate_change(change, self.catalog)  # catalog / shape before apply
        for ref in change.referenced_refs():
            if not self.objects.has(ref):
                raise SubstrateError(
                    f"apply refused: change references un-staged CAS object "
                    f"{ref[:12]}… (stage the full closure first)"
                )
        after = apply_change(view.state, change, self.catalog)
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
        after = apply_change(view.state, revert, self.catalog)
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

    def fail(bound: PolicyBound | None) -> VerifiedSubstrateView:
        # NEVER expose active state from an unverifiable stream — seed and
        # active state are both withheld (EMPTY) so no caller can act on them.
        return VerifiedSubstrateView(
            run_id=sub.run_id, task_id=sub.task_id, head=framed.head,
            seq=len(envelopes), ok=False, errors=tuple(errors), bound=bound,
            state=EMPTY_STATE, state_ref=None, seed_state=EMPTY_STATE,
            envelopes=tuple(envelopes), bodies=tuple(bodies),
            issued=MappingProxyType({}), completed=MappingProxyType({}),
            latest_checkpoint=None,
            applied_change_ids=frozenset(), reverted_change_ids=frozenset(),
        )

    # envelope structure: monotonic seq, correct scope, stable id, CLOSED body
    for index, env in enumerate(envelopes):
        if env.seq != index + 1:
            errors.append(f"envelope {index} has seq {env.seq}, expected {index + 1}")
        if env.run_id != sub.run_id:
            errors.append(f"envelope {env.seq} run_id {env.run_id!r} != {sub.run_id!r}")
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
            run_id=sub.run_id, task_id=sub.task_id, head=framed.head, seq=0,
            ok=True, errors=(), bound=None, state=EMPTY_STATE, state_ref=None,
            seed_state=EMPTY_STATE, envelopes=(), bodies=(),
            issued=MappingProxyType({}), completed=MappingProxyType({}),
            latest_checkpoint=None,
            applied_change_ids=frozenset(), reverted_change_ids=frozenset(),
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

    # the binding index must exist and AGREE with the authoritative event
    if bound.task_id != sub.task_id:
        errors.append(
            f"bound task id {bound.task_id!r} disagrees with the opened scope "
            f"{sub.task_id!r}"
        )
    if bound.surface_catalog_digest != sub.catalog.descriptor_digest():
        errors.append(
            "bound surface-catalog digest disagrees with the injected catalog — "
            "the run's legal surfaces/validators changed underneath it"
        )
    binding = _read_binding(sub.root, sub.run_id)
    if binding is None:
        errors.append("run binding index is missing (never established)")
    elif not binding.agrees_with(bound):
        errors.append("run binding index disagrees with the authoritative PolicyBound")

    # CAS closure of the bound identity
    for ref, what in [
        (bound.config_ref, "config"),
        (bound.seed_state_ref, "seed state"),
        (bound.budget_ref, "budget spec"),
    ]:
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

    # fold authority events with an exact, PURE apply/revert replay
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
            if env.caused_by != body.command_id:
                errors.append(f"envelope {env.seq}: completion causation mismatch")
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
                if cid not in applied_ids:
                    errors.append(
                        f"envelope {env.seq}: revert of {cid!r} that was never applied"
                    )
                if cid in reverted_ids:
                    errors.append(f"envelope {env.seq}: duplicate revert of {cid!r}")
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
            if not sub.objects.has(body.observation_ref):
                errors.append(
                    f"envelope {env.seq}: observation body missing from CAS"
                )
        elif isinstance(body, ChangeProposed):
            if not sub.objects.has(body.change_ref):
                errors.append(f"envelope {env.seq}: proposed change ref missing")
        # ChangeConfirmed / ChangeRevised / OperationFailed: annotation only

    if errors:
        return fail(bound)
    return VerifiedSubstrateView(
        run_id=sub.run_id, task_id=sub.task_id, head=framed.head, seq=len(envelopes),
        ok=True, errors=(), bound=bound, state=state, state_ref=state_ref,
        seed_state=seed_state, envelopes=tuple(envelopes), bodies=tuple(bodies),
        issued=MappingProxyType(dict(issued)),
        completed=MappingProxyType(dict(completed)),
        latest_checkpoint=latest_checkpoint,
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
        if not sub.catalog.allows(*key):
            errors.append(f"{what} binding {key} is not in the surface catalog")
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
