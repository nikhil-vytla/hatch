"""World generation: brief + seed -> WorldSpec (ADR-0006).

Generators are pure functions of (brief, seed). Whatever produces the spec —
template expansion, procedural sampling, or an LLM compiler plugin — the
output is an auditable, hashable WorldSpec; the kernel executes only that.

Population-scale QA is a comprehension:

    specs = [generator(brief, seed) for seed in range(n)]
"""

from __future__ import annotations

import random
from typing import Any

from orrery.plugins import Registry
from orrery.rng import derive_seed
from orrery.spec import WorldSpec


def generate(registry: Registry, template: str, brief: dict[str, Any], seed: int) -> WorldSpec:
    generator = registry.generators.get(template)
    if generator is None:
        known = ", ".join(sorted(registry.generators)) or "(none registered)"
        raise KeyError(f"no generator {template!r}; known: {known}")
    return generator(brief, seed)


def generation_rng(seed: int, template: str) -> random.Random:
    """The dedicated stream for generator sampling (never shared with the run)."""
    return random.Random(derive_seed(seed, f"generate:{template}"))
