from __future__ import annotations

import base64
import json
from pathlib import Path

from parallax.models import TaskManifest


def export_hud(
    manifests: list[TaskManifest],
    artifact_root: Path,
    output: Path,
) -> None:
    """Write portable HUD v6 task rows without sealed evaluator material."""
    rows = []
    for manifest in manifests:
        patch = (
            artifact_root / manifest.task_id / "public" / "starter.patch"
        ).read_bytes()
        rows.append(
            {
                "env": "parallax_repo",
                "id": "repair",
                "args": {
                    "task_id": manifest.task_id,
                    "source": manifest.source.locator,
                    "revision": manifest.source.revision,
                    "prompt": manifest.prompt,
                    "starter_patch_b64": base64.b64encode(patch).decode(),
                    "recipe_name": manifest.recipe_name,
                },
                "slug": manifest.task_id,
                "columns": {
                    "recipe": manifest.recipe_name,
                    "generator": manifest.generator_version,
                    "behaviors": ",".join(manifest.behavior_tags),
                },
                "agent_config": {"max_steps": 80},
            }
        )
    output.write_text(json.dumps(rows, indent=2, sort_keys=True) + "\n")


def export_verifiers(
    manifests: list[TaskManifest],
    artifact_root: Path,
    output: Path,
) -> None:
    """Write public Verifiers v1 Task rows; graders remain evaluator-side."""
    rows = []
    for index, manifest in enumerate(manifests):
        patch_path = artifact_root / manifest.task_id / "public" / "starter.patch"
        rows.append(
            {
                "idx": index,
                "name": manifest.task_id,
                "description": manifest.recipe_name,
                "prompt": manifest.prompt,
                "image": None,
                "workdir": "/workspace/repo",
                "network_allow": [],
                "artifacts": [],
                "task_id": manifest.task_id,
                "source": manifest.source.locator,
                "base_commit": manifest.source.revision,
                "starter_patch_b64": base64.b64encode(patch_path.read_bytes()).decode(),
            }
        )
    output.write_text("\n".join(json.dumps(row, sort_keys=True) for row in rows) + "\n")


def render_verifiers_taskset() -> str:
    """Return the v1 package glue expected around exported Task rows."""
    return '''\
import base64
import json
from pathlib import Path

import verifiers.v1 as vf


class RepoTask(vf.Task):
    task_id: str
    source: str
    base_commit: str
    starter_patch_b64: str


class RepoTaskset(vf.Taskset[RepoTask, vf.TasksetConfig, vf.State]):
    NEEDS_CONTAINER = True

    def load_tasks(self) -> list[RepoTask]:
        rows = Path(__file__).with_name("tasks.jsonl").read_text().splitlines()
        return [RepoTask.model_validate_json(row) for row in rows if row]

    async def setup(self, task: RepoTask, runtime: vf.Runtime) -> None:
        patch = base64.b64decode(task.starter_patch_b64)
        await runtime.write("/tmp/starter.patch", patch)
        result = await runtime.run(
            ["git", "-C", task.workdir, "apply", "/tmp/starter.patch"], {}
        )
        if result.exit_code:
            raise RuntimeError(result.stderr)

    async def validate(self, task: RepoTask, runtime: vf.Runtime) -> bool:
        result = await runtime.run(
            ["parallax-evaluator", "validate", task.task_id], {}
        )
        return result.exit_code == 0

    @vf.reward(weight=1.0)
    async def behavioral_contract(
        self, task: RepoTask, runtime: vf.Runtime
    ) -> float:
        result = await runtime.run(
            ["parallax-evaluator", "grade", task.task_id, "--json"], {}
        )
        if result.exit_code:
            return 0.0
        return float(json.loads(result.stdout)["reward"])


__all__ = ["RepoTaskset"]
'''
