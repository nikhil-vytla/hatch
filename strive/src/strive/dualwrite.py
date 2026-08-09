"""Stage-3B dual-write: mirror generation-native history into revision records.

Generation-native records (`generation@2`, `activation@2`) remain the
authoritative source of truth; this module builds their field-preserving
`revision@1` / `revision-activation@1` mirrors. The two journals are NOT one
atomic transaction: the mirror is appended after its source record, a crash
between the two leaves a detectable gap, and `parity_status` / `repair_parity`
reconstruct missing mirrors deterministically and without duplicates.

Determinism is what makes parity checkable: mirrors are pure functions of the
source records (content-addressed provenance/manifest refs included), so a
recomputed mirror either equals the journaled one or the journal is flagged
as ambiguous — never silently patched.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from typing import Protocol

from strive import codec
from strive.cas import ObjectStore
from strive.contracts import Activation, Generation
from strive.revisions import (
    LEVEL_TASK,
    HarnessRevision,
    ManifestBinding,
    MigrationProvenance,
    RevisionActivation,
    ScopeManifest,
    ScopeRef,
    content_binding,
    revision_activation_from_activation,
    revision_from_generation,
    validate_revision,
    validate_revision_activation,
    validate_scope_manifest,
)

SURFACE_NAME = "solve"  # the single strategy-code artifact of today's loop


def canonical_scope_manifest(task_id: str, source_ref: str) -> ScopeManifest:
    """The canonical task-scope manifest of a single-strategy generation."""
    manifest = ScopeManifest(
        scope=ScopeRef(LEVEL_TASK, task_id),
        bindings=(
            ManifestBinding(
                "strategy-code", SURFACE_NAME, content_binding("strategy-code", source_ref)
            ),
        ),
    )
    validate_scope_manifest(manifest)
    return manifest


def decision_ref_for(objects: ObjectStore, generation: Generation) -> str | None:
    """CAS-encode a generation's embedded decision@1 evidence (or None)."""
    if generation.decision is None:
        return None
    return objects.put_text(codec.dumps(generation.decision))


def build_generation_mirror(
    objects: ObjectStore, generation: Generation, parent: Generation | None
) -> HarnessRevision:
    """The deterministic revision@1 mirror of a generation@2 record.

    Field preservation: task fingerprint, origin, weakness, and the embedded
    decision travel via a CAS `MigrationProvenance` record referenced from
    `provenance_ref`; the delta's before binding is the parent's *content*
    ref; the scope manifest is the canonical single-binding task manifest.
    """
    scope = ScopeRef(LEVEL_TASK, generation.task_id)
    manifest_ref = objects.put_text(
        codec.dumps(canonical_scope_manifest(generation.task_id, generation.source_ref))
    )
    provenance = MigrationProvenance(
        source="generation@2",
        generation_id=generation.generation_id,
        task_id=generation.task_id,
        task_fingerprint=generation.task_fingerprint,
        origin=generation.origin,
        weakness_id=generation.weakness_id,
        decision_ref=decision_ref_for(objects, generation),
    )
    provenance_ref = objects.put_text(codec.dumps(provenance))
    revision = dataclasses.replace(
        revision_from_generation(generation, parent, scope, manifest_ref),
        provenance_ref=provenance_ref,
    )
    validate_revision(revision)
    return revision


def build_activation_mirror(
    objects: ObjectStore,
    activation: Activation,
    generations: dict[str, Generation],
) -> RevisionActivation:
    """The deterministic revision-activation@1 mirror of an activation@2.

    ``decision_ref`` carries the activated generation's embedded decision
    evidence when it has any (evolved/promoted candidates); seeds and
    rollbacks carry None.
    """
    generation = generations.get(activation.generation_id)
    decision_ref = (
        decision_ref_for(objects, generation) if generation is not None else None
    )
    mirror = revision_activation_from_activation(activation, decision_ref)
    validate_revision_activation(mirror)
    return mirror


# -- parity ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ParityReport:
    generations: int
    revisions: int
    activations: int
    revision_activations: int
    missing_revision_ids: tuple[str, ...]
    missing_activation_indices: tuple[int, ...]
    mismatched: tuple[str, ...]  # human descriptions; ambiguity, never auto-fixed

    @property
    def complete(self) -> bool:
        return not (
            self.missing_revision_ids
            or self.missing_activation_indices
            or self.mismatched
        )


class ParityError(Exception):
    """Mirror history is ambiguous (mismatched, duplicated) — repair refuses."""


def _expected_revision_id(generation_id: str) -> str:
    return generation_id.replace("gen-", "rev-")


def parity_status(store: "StoreLike") -> ParityReport:
    """Compare generation-native history with its revision mirrors."""
    generations = store.generations()
    generation_list = list(generations.values())
    revisions = {r.ref.revision_id: r for r in store.revisions()}
    if len(revisions) != len(store.revisions()):
        raise ParityError("duplicate revision ids in the mirror journal")

    missing_revisions: list[str] = []
    mismatched: list[str] = []
    for generation in generation_list:
        expected_id = _expected_revision_id(generation.generation_id)
        journaled = revisions.get(expected_id)
        parent = (
            generations[generation.parent_id]
            if generation.parent_id is not None
            else None
        )
        expected = build_generation_mirror(store.objects, generation, parent)
        if journaled is None:
            missing_revisions.append(expected_id)
        elif journaled != expected:
            mismatched.append(
                f"revision {expected_id} does not match its recomputed mirror"
            )
    unexpected = set(revisions) - {
        _expected_revision_id(g.generation_id) for g in generation_list
    }
    for revision_id in sorted(unexpected):
        mismatched.append(f"revision {revision_id} has no source generation")

    activations = store.activations()
    mirrors = store.revision_activations()
    missing_activations: list[int] = []
    for index, activation in enumerate(activations):
        expected_mirror = build_activation_mirror(
            store.objects, activation, generations
        )
        if index >= len(mirrors):
            missing_activations.append(index)
        elif mirrors[index] != expected_mirror:
            mismatched.append(
                f"activation mirror #{index} does not match its recomputed mirror"
            )
    if len(mirrors) > len(activations):
        mismatched.append(
            f"{len(mirrors) - len(activations)} revision-activations have no "
            "source activation"
        )

    return ParityReport(
        generations=len(generation_list),
        revisions=len(revisions),
        activations=len(activations),
        revision_activations=len(mirrors),
        missing_revision_ids=tuple(missing_revisions),
        missing_activation_indices=tuple(missing_activations),
        mismatched=tuple(mismatched),
    )


def repair_parity(store: "StoreLike") -> ParityReport:
    """Append missing mirrors, in source order, without duplicates.

    Refuses (raising ParityError) when existing mirrors are ambiguous —
    mismatched or unsourced records are evidence of corruption or a foreign
    writer and must be investigated, not papered over.
    """
    report = parity_status(store)
    if report.mismatched:
        raise ParityError(
            "mirror journal is ambiguous; refusing to repair: "
            + "; ".join(report.mismatched)
        )
    generations = store.generations()
    for revision_id in report.missing_revision_ids:
        generation_id = revision_id.replace("rev-", "gen-")
        generation = generations[generation_id]
        parent = (
            generations[generation.parent_id]
            if generation.parent_id is not None
            else None
        )
        store.append_revision(build_generation_mirror(store.objects, generation, parent))
    activations = store.activations()
    for index in report.missing_activation_indices:
        store.append_revision_activation(
            build_activation_mirror(store.objects, activations[index], generations)
        )
    return parity_status(store)


class StoreLike(Protocol):
    """Structural interface dualwrite needs from the store (avoids an import
    cycle; `strive.store.Store` satisfies it)."""

    objects: ObjectStore

    def generations(self) -> dict[str, Generation]: ...
    def activations(self) -> list[Activation]: ...
    def revisions(self) -> list[HarnessRevision]: ...
    def revision_activations(self) -> list[RevisionActivation]: ...
    def append_revision(self, revision: HarnessRevision) -> None: ...
    def append_revision_activation(self, activation: RevisionActivation) -> None: ...
