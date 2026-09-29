"""tally's errors: every one has a stable code from errors/registry.json.

Support staff and the API's clients look errors up by code, so a code never
changes meaning once released.
"""

from __future__ import annotations

import json
from functools import cache
from pathlib import Path

__all__ = ["REGISTRY", "TallyError", "fail", "registry"]

REGISTRY = Path(__file__).resolve().parent.parent / "errors" / "registry.json"


class TallyError(Exception):
    """An error with a registered code, a name and a message for people."""

    def __init__(self, code: str, name: str, message: str) -> None:
        super().__init__(f"{code} {message}")
        self.code = code
        self.name = name
        self.message = message


@cache
def registry() -> dict:
    """The registry file, parsed."""
    return json.loads(REGISTRY.read_text())


def fail(name: str, **fields: object) -> TallyError:
    """Raises the registered error `name`, its message filled from `fields`."""
    entry = registry()["errors"].get(name)
    if entry is None:
        raise KeyError(f"{name} isn't in errors/registry.json")
    raise TallyError(entry["code"], name, entry["message"].format(**fields))
