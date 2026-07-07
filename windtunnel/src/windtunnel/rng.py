"""Named, independent RNG streams under a single root seed (ADR-0003).

Every stochastic draw in a simulation flows through a stream requested by name
from the run's `RngRegistry`. Streams are derived by hashing (root_seed, name),
so they are independent by construction: creating or consuming stream B can
never shift the draws of stream A, and adding a new actor to a world does not
perturb existing actors' behavior under the same seed.
"""

from __future__ import annotations

import hashlib
import random


def derive_seed(root_seed: int, name: str) -> int:
    digest = hashlib.sha256(f"{root_seed}\x1f{name}".encode()).digest()
    return int.from_bytes(digest[:8], "big")


class RngRegistry:
    def __init__(self, root_seed: int) -> None:
        self.root_seed = root_seed
        self._streams: dict[str, random.Random] = {}

    def stream(self, name: str) -> random.Random:
        """Return the stream for `name`, creating it deterministically on first use."""
        if name not in self._streams:
            self._streams[name] = random.Random(derive_seed(self.root_seed, name))
        return self._streams[name]

    def stream_names(self) -> list[str]:
        return sorted(self._streams)
