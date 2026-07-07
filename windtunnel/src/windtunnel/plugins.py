"""Plugin registry and discovery (no global mutable state).

A `Registry` instance is built per run: built-ins first, then Python entry
points (groups "windtunnel.policies", "windtunnel.verifiers", ...), then the modules
named in the spec's `uses` list. Domain packs and third-party packages expose
`register(registry)` (or a group-specific function) to add policies,
mechanics, reducers, tools, verifier factories, and generators.
"""

from __future__ import annotations

import importlib
import importlib.metadata
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

PolicyFactory = Callable[[dict[str, Any]], Any]
VerifierFactory = Callable[[str, dict[str, Any]], Any]
GeneratorFn = Callable[[dict[str, Any], int], Any]  # (brief, seed) -> WorldSpec
AdapterFn = Callable[[list[dict[str, Any]], dict[str, Any]], Any]  # (rows, brief) -> [WorldSpec]
ClientFactory = Callable[[dict[str, Any]], Any]  # params -> ModelClient

ENTRY_POINT_GROUPS = ("windtunnel.policies", "windtunnel.verifiers", "windtunnel.domains")


@dataclass
class Registry:
    policies: dict[str, PolicyFactory] = field(default_factory=dict)
    mechanics: dict[str, Any] = field(default_factory=dict)
    reducers: dict[str, Any] = field(default_factory=dict)
    tools: dict[str, Any] = field(default_factory=dict)
    verifiers: dict[str, VerifierFactory] = field(default_factory=dict)
    generators: dict[str, GeneratorFn] = field(default_factory=dict)
    adapters: dict[str, AdapterFn] = field(default_factory=dict)
    model_clients: dict[str, ClientFactory] = field(default_factory=dict)

    def use_module(self, module_path: str) -> None:
        """Import a domain module and let it register itself."""
        module = importlib.import_module(module_path)
        register = getattr(module, "register", None)
        if register is None:
            raise ValueError(f"module {module_path} has no register(registry) function")
        register(self)


def build_registry(uses: list[str] | None = None, discover: bool = False) -> Registry:
    from windtunnel import actors, adapters, models, perturb, verify, world

    registry = Registry()
    world.register_builtin(registry)
    actors.register_builtin_policies(registry)
    verify.register_builtin_verifiers(registry)
    perturb.register(registry)
    models.register(registry)
    adapters.register(registry)

    if discover:  # third-party packages, via entry points
        for group in ENTRY_POINT_GROUPS:
            for entry_point in importlib.metadata.entry_points(group=group):
                hook = entry_point.load()
                hook(registry)

    for module_path in uses or []:
        registry.use_module(module_path)
    return registry
