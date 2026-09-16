"""A fresh interpreter verifies without candidate code or heavy dependencies."""

from pathlib import Path

from .fresh_probe import fresh_replay
from .storage_fixtures import complete_history
from .test_storage_verification import snapshot


def test_fresh_interpreter_verifier_is_read_only_and_candidate_free(tmp_path: Path) -> None:
    root = tmp_path / "vnext"
    complete_history(root)
    before = snapshot(root)
    fresh_replay(root, corrupt=False)
    assert snapshot(root) == before
