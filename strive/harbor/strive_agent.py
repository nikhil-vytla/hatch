"""strive as a Harbor agent, for Terminal-Bench and other Harbor datasets.

Each trial's container gets strive's Linux binaries (build them with
scripts/build-linux.sh) and runs the instruction as one headless task:
`strive run --json --approvals full-auto`. The container is the sandbox, so
the settings turn strive's own off. The model comes from Harbor's -m flag
(anthropic/<model>), the key from ANTHROPIC_API_KEY, and every entry of the
session's journal lands in the trial's agent logs as strive.jsonl.

    PYTHONPATH=harbor harbor run -d terminal-bench@2.0 -a strive_agent:Strive \\
        -m anthropic/claude-haiku-4-5 --n-tasks 1
"""

import json
import os
import tempfile
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

DIST = Path(os.environ.get("STRIVE_LINUX_DIST", Path(__file__).resolve().parent.parent / ".audit/linux/dist"))
BUDGET_USD = float(os.environ.get("STRIVE_BUDGET_USD", "1"))
TURN_SECONDS = int(os.environ.get("STRIVE_TURN_SECONDS", "1500"))


class Strive(BaseAgent):
    @staticmethod
    def name() -> str:
        return "strive"

    def version(self) -> str:
        return "0.3.0-dev"

    def _model(self) -> str:
        if not self.model_name or not self.model_name.startswith("anthropic/"):
            raise ValueError("strive's Harbor agent takes -m anthropic/<model>")
        return self.model_name.removeprefix("anthropic/")

        async def setup(self, environment: BaseEnvironment) -> None:
        # The container's architecture, which can differ from this machine's
        # (Terminal-Bench images are amd64; on an arm64 Mac they are emulated).
        uname = await environment.exec(command="uname -m")
        arch = (uname.stdout or "").strip().replace("arm64", "aarch64")
        for binary in ("strive", "strive-tui"):
            path = DIST / arch / binary
            if not path.is_file():
                raise FileNotFoundError(f"{path}: build it with scripts/build-linux.sh {arch}")
            await environment.upload_file(path, f"/usr/local/bin/{binary}")
        settings = {
            "sandbox": "off",
            "model": self._model(),
            "budget": {"usd": BUDGET_USD},
            "turnSeconds": TURN_SECONDS,
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(settings, f)
        home = await environment.exec(command="mkdir -p ~/.strive && chmod +x /usr/local/bin/strive* && echo $HOME")
        await environment.upload_file(f.name, f"{(home.stdout or '/root').strip()}/.strive/settings.json")
        os.unlink(f.name)

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write(instruction)
        await environment.upload_file(f.name, "/tmp/strive-task.txt")
        os.unlink(f.name)
        logs = self.environment_logs_dir
        # The key must be in the environment before the daemon starts: it
        # reads keys when it does, and `strive run` starts it.
        await environment.exec(
            command=f"strive run --json --approvals full-auto - < /tmp/strive-task.txt > {logs}/strive.jsonl 2> {logs}/strive.err",
            env={"ANTHROPIC_API_KEY": os.environ["ANTHROPIC_API_KEY"]},
            timeout_sec=TURN_SECONDS + 120,
        )
        self._count(context)

    def _count(self, context: AgentContext) -> None:
        """Tokens and cost from the model calls the journal records."""
        path = self.logs_dir / "strive.jsonl"
        if not path.is_file():
            return
        inputs = outputs = cached = cost = 0
        for line in path.read_text().splitlines():
            event = json.loads(line)["event"]
            if event["type"] != "modelCallFinished":
                continue
            outcome = event["outcome"]
            if outcome["kind"] == "complete":
                usage = outcome["usage"]
                inputs += usage["input"]
                outputs += usage["output"]
                cached += usage.get("cacheRead", 0)
            cost += outcome.get("costUsdMicros", 0)
        context.n_input_tokens = inputs
        context.n_output_tokens = outputs
        context.n_cache_tokens = cached
        context.cost_usd = cost / 1_000_000
