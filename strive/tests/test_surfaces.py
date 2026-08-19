"""The injected surface catalog and trusted structural validators."""

from __future__ import annotations

import pytest

from strive.surfaces import (
    SurfaceValidationError,
    default_surface_catalog,
    validate_prompt,
    validate_solve_code,
)


def test_valid_solve_code() -> None:
    validate_solve_code("def solve(input_text: str) -> int:\n    return 0\n")
    validate_solve_code("def solve(input_text):\n    return 1\n")  # annotations optional


@pytest.mark.parametrize(
    "bad",
    [
        "def solve(t):\n    return 0\n",                # wrong parameter name
        "x = 1\n",                                      # no solve at all
        "def solve(a, b):\n    return 0\n",             # too many parameters
        "def solve(input_text: str) -> int:\n    return (\n",  # syntax error
        "async def solve(input_text):\n    return 0\n",  # async
        "def solve(input_text):\n    return 0\n"
        "def solve(input_text):\n    return 1\n",       # two solves
        "def solve(*args):\n    return 0\n",            # vararg
    ],
)
def test_invalid_solve_code(bad: str) -> None:
    with pytest.raises(SurfaceValidationError):
        validate_solve_code(bad)


def test_prompt_validator() -> None:
    validate_prompt("a real template")
    with pytest.raises(SurfaceValidationError):
        validate_prompt("   \n  ")


def test_catalog_membership_and_stable_digest() -> None:
    catalog = default_surface_catalog()
    assert catalog.allows("strategy-code", "solve")
    assert catalog.allows("prompt", "proposal-template")
    assert not catalog.allows("secret-keys", "prod")
    # the digest is stable across constructions and pins the validator names
    assert catalog.descriptor_digest() == default_surface_catalog().descriptor_digest()


def test_catalog_content_validation_dispatches() -> None:
    catalog = default_surface_catalog()
    catalog.validate_content("strategy-code", "solve", "def solve(input_text):\n    return 0\n")
    with pytest.raises(SurfaceValidationError):
        catalog.validate_content("strategy-code", "solve", "def nope(): pass\n")
    with pytest.raises(SurfaceValidationError):
        catalog.validate_content("prompt", "proposal-template", "")
