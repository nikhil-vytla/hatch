"""Offline M7 manifests and repeatable paired studies."""
from pathlib import Path
import tomllib

from strive.vnext.cli.data import mapping, toml
from strive.vnext.cli.fixture import example


def spec(strictness: str = "matched") -> dict[str, object]:
    return {"strictness": strictness, "allowed_differences": ["run.editable"], "horizon": 2,
        "pairing": "workload_seed", "metric": "cumulative_successes", "exclusions": [],
        "stopping": "budget-or-horizon", "selection": "final_valid_active_actor_from_every_trajectory",
        "uncertainty": "paired-normal-95"}


def campaign(directory: Path, *, target: int = 7, reps: int = 1) -> Path:
    manifest = example(directory)
    allocation = {"usd_nanodollars": 0, "tokens": 10000, "model_calls": 10, "wall_seconds": 120}
    data = {"id": "reference", "base": manifest.name, "repetitions": reps,
        "seeds": list(range(17, 17 + reps)), "pairing": "workload_seed",
        "arms": {"fixed": {"run.editable": []}, "adapting": {"run.editable": ["actor.code", "actor.prompts", "actor.memory"]}},
        "allocations": {"fixed": allocation, "adapting": allocation,
            "total": {k: v * 2 * reps for k, v in allocation.items()}},
        "audit": {"allocation": {k: v * 2 * reps for k, v in allocation.items()}, "target": target,
                  "destination": "audit:reference", "selection": "final_valid_active_actor_from_every_trajectory"},
        "analysis": spec()}
    path = directory / "study.toml"
    path.write_text(toml(data))
    return path


def edit_manifest(path: Path, table: str, key: str, value: object) -> None:
    data = mapping(tomllib.loads(path.read_text()))
    section = mapping(data[table])
    section[key] = value
    data[table] = section
    path.write_text(toml(data))
