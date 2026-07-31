from __future__ import annotations

import difflib
import hashlib
from pathlib import Path

from parallax.models import TextEdit


class EditError(ValueError):
    """An edit did not match the pinned source exactly."""


def apply_edits(root: Path, edits: tuple[TextEdit, ...]) -> None:
    for edit in edits:
        path = _safe_path(root, edit.path)
        original = path.read_text()
        count = original.count(edit.before)
        if count != edit.expected_occurrences:
            raise EditError(
                f"{edit.id}: expected {edit.expected_occurrences} occurrence(s) "
                f"in {edit.path}, found {count}"
            )
        path.write_text(original.replace(edit.before, edit.after))


def make_patch(before_root: Path, after_root: Path, paths: tuple[str, ...]) -> str:
    chunks: list[str] = []
    for relative in sorted(set(paths)):
        before = _safe_path(before_root, relative).read_text().splitlines(keepends=True)
        after = _safe_path(after_root, relative).read_text().splitlines(keepends=True)
        chunks.extend(
            difflib.unified_diff(
                before,
                after,
                fromfile=f"a/{relative}",
                tofile=f"b/{relative}",
            )
        )
    return "".join(chunks)


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _safe_path(root: Path, relative: str) -> Path:
    candidate = (root / relative).resolve()
    resolved_root = root.resolve()
    if not candidate.is_relative_to(resolved_root):
        raise EditError(f"path escapes repository root: {relative}")
    if not candidate.is_file():
        raise EditError(f"edit target is not a file: {relative}")
    return candidate
