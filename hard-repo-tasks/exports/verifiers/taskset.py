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
