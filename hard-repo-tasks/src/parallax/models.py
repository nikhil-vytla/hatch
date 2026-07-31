from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SourceSpec:
    locator: str
    revision: str
    license: str = "unknown"


@dataclass(frozen=True)
class TextEdit:
    id: str
    path: str
    before: str
    after: str
    expected_occurrences: int = 1


@dataclass(frozen=True)
class Check:
    name: str
    argv: tuple[str, ...]
    weight: float
    category: str
    timeout_seconds: int = 120
    env: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Recipe:
    name: str
    source: SourceSpec
    prompt: str
    implementation_edits: tuple[TextEdit, ...]
    starter_omissions: tuple[str, ...]
    probe_edits: tuple[TextEdit, ...]
    checks: tuple[Check, ...]
    allowed_paths: tuple[str, ...]
    behavior_tags: tuple[str, ...] = ()
    generator_version: str = "parallax-v0.1"

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> Recipe:
        return cls(
            name=value["name"],
            source=SourceSpec(**value["source"]),
            prompt=value["prompt"],
            implementation_edits=tuple(TextEdit(**edit) for edit in value["implementation_edits"]),
            starter_omissions=tuple(value["starter_omissions"]),
            probe_edits=tuple(TextEdit(**edit) for edit in value.get("probe_edits", [])),
            checks=tuple(
                Check(
                    **{
                        **check,
                        "argv": tuple(check["argv"]),
                    }
                )
                for check in value["checks"]
            ),
            allowed_paths=tuple(value["allowed_paths"]),
            behavior_tags=tuple(value.get("behavior_tags", [])),
            generator_version=value.get("generator_version", "parallax-v0.1"),
        )

    @classmethod
    def load(cls, path: Path) -> Recipe:
        return cls.from_dict(json.loads(path.read_text()))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class TaskManifest:
    task_id: str
    recipe_name: str
    source: SourceSpec
    prompt: str
    starter_patch_sha256: str
    generator_version: str
    behavior_tags: tuple[str, ...]
    allowed_paths: tuple[str, ...]

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> TaskManifest:
        return cls(
            task_id=value["task_id"],
            recipe_name=value["recipe_name"],
            source=SourceSpec(**value["source"]),
            prompt=value["prompt"],
            starter_patch_sha256=value["starter_patch_sha256"],
            generator_version=value["generator_version"],
            behavior_tags=tuple(value.get("behavior_tags", [])),
            allowed_paths=tuple(value["allowed_paths"]),
        )

    @classmethod
    def load(cls, path: Path) -> TaskManifest:
        return cls.from_dict(json.loads(path.read_text()))

    def dump(self, path: Path) -> None:
        path.write_text(json.dumps(asdict(self), indent=2, sort_keys=True) + "\n")

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
