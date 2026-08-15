"""The injected, immutable surface catalog and trusted content validators.

A surface is a named slot in the composite harness state (e.g.
``strategy-code/solve``). Which surfaces exist, and what counts as
structurally valid content for each, is NOT hard-coded into the substrate:
it is an injected `SurfaceCatalog`. Every run's `PolicyBound` pins the
catalog's descriptor digest, so a run cannot silently change which surfaces
are legal or how their content is validated.

Trusted structural validators run BEFORE any content is seeded or applied:
the code validator parses the source and requires exactly one top-level
``solve(input_text: str) -> int``; the prompt validator requires non-empty
text. They are deliberately conservative — a semantic check the substrate
can make cheaply and deterministically, not a full type-check of untrusted
code (that is the sandbox's job).
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from typing import Callable

from strive.cas import hash_text


class SurfaceValidationError(Exception):
    """Structurally invalid content for a surface (rejected before seed/apply)."""


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


@dataclass(frozen=True)
class SurfaceDescriptor:
    """One legal surface: its (kind, name) key, a stable validator name, and
    the trusted structural validator run before seed/apply."""

    kind: str
    name: str
    validator_name: str
    validator: Callable[[str], None]

    @property
    def key(self) -> tuple[str, str]:
        return (self.kind, self.name)


class SurfaceCatalog:
    """An immutable set of surface descriptors, resolved by exact (kind, name).
    Its `descriptor_digest()` is a stable content address pinned per run so a
    run's legal surfaces and validators cannot be swapped underneath it."""

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

    def descriptor_digest(self) -> str:
        """A stable content address over the catalog's surfaces + validator
        names (NOT the function objects), pinned in `PolicyBound`."""
        canon = ";".join(
            f"{d.kind}/{d.name}:{d.validator_name}"
            for d in sorted(self._by_key.values(), key=lambda d: d.key)
        )
        return hash_text(f"surface-catalog@1|{canon}")


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
    "SurfaceValidationError",
    "default_surface_catalog",
    "validate_prompt",
    "validate_solve_code",
]
