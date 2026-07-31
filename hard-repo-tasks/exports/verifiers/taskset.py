import base64
import json
from importlib.resources import files

import verifiers as vf


class RepoTaskData(vf.TaskData):
    task_id: str
    source: str
    base_commit: str
    starter_patch_b64: str


class RepoTask(vf.Task[RepoTaskData]):
    NEEDS_CONTAINER = True

    async def setup(self, runtime: vf.Runtime) -> None:
        patch = base64.b64decode(self.data.starter_patch_b64)
        await runtime.write("/tmp/starter.patch", patch)
        result = await runtime.run(
            ["git", "-C", self.data.workdir, "apply", "/tmp/starter.patch"], {}
        )
        if result.exit_code:
            raise RuntimeError(result.stderr)

    async def validate(self, runtime: vf.Runtime) -> bool:
        result = await runtime.run(
            ["parallax-evaluator", "validate", self.data.task_id], {}
        )
        return result.exit_code == 0

    @vf.reward(weight=1.0)
    async def behavioral_contract(self, runtime: vf.Runtime) -> float:
        result = await runtime.run(
            ["parallax-evaluator", "grade", self.data.task_id, "--json"], {}
        )
        if result.exit_code:
            return 0.0
        return float(json.loads(result.stdout)["reward"])


class RepoTaskset(vf.Taskset[RepoTask]):
    def load(self):
        rows = files(__package__).joinpath("tasks.jsonl").read_text().splitlines()
        return [RepoTask(RepoTaskData.model_validate_json(row)) for row in rows if row]


__all__ = ["RepoTaskset"]
