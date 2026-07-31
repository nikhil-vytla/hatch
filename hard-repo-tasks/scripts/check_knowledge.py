"""Validate typed notes and semantic links in the research knowledge base."""

from __future__ import annotations

import sys
import tomllib
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
KNOWLEDGE_ROOT = ROOT / "knowledge"
KINDS = {"concept", "question", "source", "synthesis"}
CONFIDENCE = {"high", "low", "medium", "unknown"}
STATUSES = {"active", "archived", "contested", "superseded"}
RELATIONS = {"broader", "challenges", "related", "supported_by"}
BASE_FIELDS = {"confidence", "id", "kind", "relations", "status", "tags", "title", "updated"}
SOURCE_FIELDS = {"accessed", "authors", "primary", "source_type", "url", "year"}


@dataclass(frozen=True)
class Note:
    path: Path
    metadata: dict[str, Any]

    @property
    def id(self) -> str:
        return str(self.metadata["id"])


def parse_note(path: Path) -> Note:
    text = path.read_text()
    lines = text.splitlines()
    if not lines or lines[0] != "+++":
        raise ValueError("missing opening TOML delimiter")
    try:
        end = lines.index("+++", 1)
    except ValueError as error:
        raise ValueError("missing closing TOML delimiter") from error
    metadata = tomllib.loads("\n".join(lines[1:end]))
    return Note(path=path, metadata=metadata)


def note_paths() -> list[Path]:
    return sorted(
        path
        for path in KNOWLEDGE_ROOT.rglob("*.md")
        if path.name != "README.md" and "templates" not in path.parts
    )


def validate_note(note: Note) -> list[str]:
    metadata = note.metadata
    errors: list[str] = []
    missing = BASE_FIELDS - metadata.keys()
    if missing:
        errors.append(f"missing fields: {sorted(missing)}")

    kind = metadata.get("kind")
    if kind not in KINDS:
        errors.append(f"invalid kind: {kind!r}")
    if metadata.get("confidence") not in CONFIDENCE:
        errors.append(f"invalid confidence: {metadata.get('confidence')!r}")
    if metadata.get("status") not in STATUSES:
        errors.append(f"invalid status: {metadata.get('status')!r}")
    if not isinstance(metadata.get("tags"), list) or not metadata.get("tags"):
        errors.append("tags must be a non-empty list")

    note_id = metadata.get("id")
    if not isinstance(note_id, str) or not note_id.startswith(f"{kind}."):
        errors.append(f"id must start with {kind!r} namespace")

    relations = metadata.get("relations")
    if not isinstance(relations, dict):
        errors.append("relations must be a table")
    else:
        missing_relations = RELATIONS - relations.keys()
        unknown_relations = relations.keys() - RELATIONS
        if missing_relations:
            errors.append(f"missing relations: {sorted(missing_relations)}")
        if unknown_relations:
            errors.append(f"unknown relations: {sorted(unknown_relations)}")
        for relation, targets in relations.items():
            if not isinstance(targets, list) or not all(
                isinstance(target, str) for target in targets
            ):
                errors.append(f"relation {relation!r} must be a list of note IDs")

    if kind == "source":
        missing_source = SOURCE_FIELDS - metadata.keys()
        if missing_source:
            errors.append(f"missing source fields: {sorted(missing_source)}")

    return errors


def validate_graph(notes: list[Note]) -> list[str]:
    errors: list[str] = []
    ids = [note.id for note in notes]
    duplicates = sorted(note_id for note_id, count in Counter(ids).items() if count > 1)
    if duplicates:
        errors.append(f"duplicate IDs: {duplicates}")

    known = set(ids)
    for note in notes:
        relations = note.metadata.get("relations", {})
        if not isinstance(relations, dict):
            continue
        for relation, targets in relations.items():
            if not isinstance(targets, list):
                continue
            for target in targets:
                if target not in known:
                    errors.append(f"{note.id}: {relation} targets unknown ID {target!r}")
                if target == note.id:
                    errors.append(f"{note.id}: {relation} contains a self-link")
    return errors


def main() -> int:
    notes: list[Note] = []
    errors: list[str] = []
    for path in note_paths():
        try:
            note = parse_note(path)
        except (ValueError, tomllib.TOMLDecodeError) as error:
            errors.append(f"{path.relative_to(ROOT)}: {error}")
            continue
        notes.append(note)
        errors.extend(
            f"{path.relative_to(ROOT)}: {message}" for message in validate_note(note)
        )

    errors.extend(validate_graph(notes))
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1

    counts = Counter(str(note.metadata["kind"]) for note in notes)
    summary = ", ".join(f"{kind}={counts[kind]}" for kind in sorted(counts))
    print(f"validated {len(notes)} notes ({summary})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
