"""The injected, immutable surface catalog and trusted content validators.

A surface is a named slot in the composite harness state (e.g.
``strategy-code/solve``). Which surfaces exist, and what counts as
structurally valid content for each, is NOT hard-coded into the substrate:
it is an injected `SurfaceCatalog`.

Extensibility is version-safe. A run does not pin the WHOLE catalog's digest
(which would break every old run the moment a new surface is added). Instead
it pins, per surface it may touch, a content-addressed
`SurfaceDescriptorSnapshot` — the surface key, the validator NAME, and a
digest of the validator's IMPLEMENTATION. Verification resolves each run's
surfaces from those pinned snapshots, so:

- adding a brand-new descriptor to the live catalog never invalidates an
  existing run (its pinned snapshots are unchanged);
- changing or removing a validator that an old run pinned is detected as
  drift (the live implementation digest no longer matches the pinned one).

Trusted structural validators run BEFORE any content is seeded or applied:
the code validator parses the source and requires exactly one top-level
``solve(input_text)``; the prompt validator requires non-empty text. They are
deliberately conservative — a cheap, deterministic semantic check, not a full
type-check of untrusted code (that is the sandbox's job).
"""

from __future__ import annotations

import ast
import inspect
from dataclasses import dataclass
from typing import Callable

from strive.cas import hash_text
from strive.codec import register


class SurfaceValidationError(Exception):
    """Structurally invalid content for a surface, or a validator/descriptor
    that drifted from the pinned snapshot (rejected before seed/apply)."""


def validate_solve_code(source: str) -> None:
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        raise SurfaceValidationError(f"strategy code does not parse: {exc}") from None
    solves = [
        node
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name == "solve"
    ]
    if len(solves) != 1:
        raise SurfaceValidationError(
            f"strategy code must define exactly one top-level solve(); found "
            f"{len(solves)}"
        )
    solve = solves[0]
    if isinstance(solve, ast.AsyncFunctionDef):
        raise SurfaceValidationError("solve() must be a plain (non-async) function")
    args = solve.args
    positional = [a.arg for a in args.posonlyargs + args.args]
    if positional != ["input_text"] or args.vararg or args.kwarg or args.kwonlyargs:
        raise SurfaceValidationError(
            "solve() must take exactly one parameter named 'input_text'"
        )


def validate_prompt(text: str) -> None:
    if not text.strip():
        raise SurfaceValidationError("prompt surface content must be non-empty")


@register("surface-descriptor", 1)
@dataclass(frozen=True)
class SurfaceDescriptorSnapshot:
    """The content-addressed, pinned identity of one surface's validator: its
    key, the validator NAME (carries a version, e.g. ``solve-code@1``), and a
    digest of the validator's IMPLEMENTATION. Pinned per run in `PolicyBound`
    so historical runs resolve their validators independently of later catalog
    edits."""

    kind: str
    name: str
    validator_name: str
    validator_impl_digest: str


def _impl_digest(validator_name: str, validator: Callable[[str], None]) -> str:
    try:
        source = inspect.getsource(validator)
    except (OSError, TypeError):
        source = getattr(validator, "__qualname__", repr(validator))
    return hash_text(f"{validator_name}\n{source}")


@dataclass(frozen=True)
class SurfaceDescriptor:
    """One legal surface: its (kind, name) key, a versioned validator name, and
    the trusted structural validator run before seed/apply."""

    kind: str
    name: str
    validator_name: str
    validator: Callable[[str], None]

    @property
    def key(self) -> tuple[str, str]:
        return (self.kind, self.name)

    def impl_digest(self) -> str:
        return _impl_digest(self.validator_name, self.validator)

    def snapshot(self) -> SurfaceDescriptorSnapshot:
        return SurfaceDescriptorSnapshot(
            kind=self.kind, name=self.name, validator_name=self.validator_name,
            validator_impl_digest=self.impl_digest(),
        )


class SurfaceCatalog:
    """An immutable set of surface descriptors, resolved by exact (kind, name)."""

    def __init__(self, descriptors: tuple[SurfaceDescriptor, ...]) -> None:
        by_key: dict[tuple[str, str], SurfaceDescriptor] = {}
        for descriptor in descriptors:
            if descriptor.key in by_key:
                raise ValueError(f"duplicate surface descriptor {descriptor.key}")
            by_key[descriptor.key] = descriptor
        self._by_key: dict[tuple[str, str], SurfaceDescriptor] = by_key

    def keys(self) -> frozenset[tuple[str, str]]:
        return frozenset(self._by_key)

    def allows(self, kind: str, name: str) -> bool:
        return (kind, name) in self._by_key

    def descriptor(self, kind: str, name: str) -> SurfaceDescriptor:
        try:
            return self._by_key[(kind, name)]
        except KeyError:
            raise SurfaceValidationError(
                f"surface {(kind, name)} is not in the catalog "
                f"(allowed: {sorted(self._by_key)})"
            ) from None

    def validate_content(self, kind: str, name: str, content: str) -> None:
        self.descriptor(kind, name).validator(content)

    def snapshots(self) -> dict[str, SurfaceDescriptorSnapshot]:
        """One pinned snapshot per surface, keyed by ``"kind/name"``."""
        return {
            f"{d.kind}/{d.name}": d.snapshot()
            for d in self._by_key.values()
        }

    def resolve_pinned(self, snapshot: SurfaceDescriptorSnapshot) -> SurfaceDescriptor:
        """Resolve the live validator for a pinned snapshot, refusing drift:
        the live descriptor must still exist and its implementation digest must
        equal the pinned one."""
        descriptor = self._by_key.get((snapshot.kind, snapshot.name))
        if descriptor is None:
            raise SurfaceValidationError(
                f"pinned surface {(snapshot.kind, snapshot.name)} is no longer in "
                "the catalog — cannot validate this run's content"
            )
        if descriptor.validator_name != snapshot.validator_name:
            raise SurfaceValidationError(
                f"pinned surface {(snapshot.kind, snapshot.name)} validator name "
                f"drifted ({snapshot.validator_name!r} -> {descriptor.validator_name!r})"
            )
        if descriptor.impl_digest() != snapshot.validator_impl_digest:
            raise SurfaceValidationError(
                f"pinned surface {(snapshot.kind, snapshot.name)} validator "
                "implementation changed since the run was bound"
            )
        return descriptor

    def descriptor_digest(self) -> str:
        """A stable content address over ALL surfaces + validator impl digests
        (used only for reporting; per-run pinning uses `snapshots()`)."""
        canon = ";".join(
            f"{d.kind}/{d.name}:{d.validator_name}:{d.impl_digest()}"
            for d in sorted(self._by_key.values(), key=lambda d: d.key)
        )
        return hash_text(f"surface-catalog@2|{canon}")


def default_surface_catalog() -> SurfaceCatalog:
    return SurfaceCatalog(
        (
            SurfaceDescriptor(
                "strategy-code", "solve", "solve-code@1", validate_solve_code
            ),
            SurfaceDescriptor(
                "prompt", "proposal-template", "prompt-text@1", validate_prompt
            ),
        )
    )


__all__ = [
    "SurfaceCatalog",
    "SurfaceDescriptor",
    "SurfaceDescriptorSnapshot",
    "SurfaceValidationError",
    "default_surface_catalog",
    "validate_prompt",
    "validate_solve_code",
]
