"""strive as a Harbor installed agent.

Harbor copies Linux builds of `strive` and `strive-tui` (see
`build-linux.sh`) into the task's container and runs one headless session
there: `strive run <instruction> --json`. The container is the sandbox, so
strive's own sandbox is off and approvals are full-auto. The session's
journal is copied to the trial's agent logs, and its model calls' tokens and
exact cost are reported to Harbor.

    PYTHONPATH=bench/harbor harbor run -t hello-world/hello-world \\
        -a strive_agent:Strive -m anthropic/claude-haiku-4-5
"""

import json
import os
import shlex
import tempfile
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

STRIVE_ROOT = Path(__file__).resolve().parents[2]
REMOTE_BIN = "/opt/strive"
REMOTE_HOME = "/tmp/strive-home"
LOGS = "/logs/agent"
JOURNAL = "strive.jsonl"


class Strive(BaseInstalledAgent):
    """One strive session per trial.

    Agent kwargs (`--ak`): `budget_usd` (the session's spending limit,
    default 2), `binaries` (a directory holding `strive` and `strive-tui`
    per architecture as `linux-arm64` and `linux-amd64`; default strive's
    `target`). Each trial's container starts empty, so nothing is learned
    from one trial to the next.
    """

    def __init__(
        self,
        logs_dir: Path,
        budget_usd: float | str = 2.0,
        binaries: str | None = None,
        **kwargs,
    ):
        super().__init__(logs_dir, **kwargs)
        self.budget_usd = float(budget_usd)
        self.binaries = Path(binaries) if binaries else STRIVE_ROOT / "target"

    @staticmethod
    def name() -> str:
        return "strive"

    def version(self) -> str | None:
        return "0.3.0-dev"

    def _model(self) -> str | None:
        """The model as strive names it: Harbor's `anthropic/claude-x` without the provider."""
        if not self.model_name:
            return None
        return self.model_name.split("/", 1)[-1]

    def _settings(self) -> dict:
        settings: dict = {
            "sandbox": "off",
            "approvals": "fullAuto",
            "budget": {"usd": self.budget_usd},
            "learning": {"mode": "off", "ask": False},
        }
        if model := self._model():
            settings["model"] = model
        return settings

    async def install(self, environment: BaseEnvironment) -> None:
        machine = (await self.exec_as_root(environment, command="uname -m")).stdout.strip()
        arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64"}.get(machine)
        if arch is None:
            raise RuntimeError(f"strive has no Linux build for {machine}")
        built = self.binaries / f"linux-{arch}"
        for exe in ("strive", "strive-tui"):
            if not (built / exe).is_file():
                raise RuntimeError(
                    f"{built / exe} is missing; run bench/harbor/build-linux.sh {arch}"
                )
        await self.exec_as_root(environment, command=f"mkdir -p {REMOTE_BIN} {REMOTE_HOME}")
        for exe in ("strive", "strive-tui"):
            await environment.upload_file(built / exe, f"{REMOTE_BIN}/{exe}")
        with tempfile.TemporaryDirectory(prefix="strive-harbor-") as tmp:
            settings = Path(tmp) / "settings.json"
            settings.write_text(json.dumps(self._settings(), indent=2))
            await environment.upload_file(settings, f"{REMOTE_HOME}/settings.json")
        owner = environment.default_user
        chown = f" && chown -R {shlex.quote(str(owner))} {REMOTE_HOME}" if owner is not None else ""
        await self.exec_as_root(
            environment,
            command=f"chmod 755 {REMOTE_BIN}/strive {REMOTE_BIN}/strive-tui{chown}",
        )

    def _env(self) -> dict[str, str]:
        env = {"STRIVE_HOME": REMOTE_HOME, "PATH": f"{REMOTE_BIN}:/usr/local/bin:/usr/bin:/bin"}
        # Keys and upstreams from the machine running Harbor; nothing else of it.
        for name in (
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "STRIVE_UPSTREAM_ANTHROPIC",
            "STRIVE_UPSTREAM_OPENAI",
        ):
            if value := os.environ.get(name):
                env[name] = value
        return env

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        run = (
            f"strive run {shlex.quote(instruction)} --approvals full-auto"
            f" --budget {self.budget_usd} --json > {LOGS}/{JOURNAL} 2> {LOGS}/strive.stderr"
        )
        # The verifier scores the trial; how strive's run ended is recorded, not raised.
        await self.exec_as_agent(
            environment,
            command=(
                f"{run}; echo $? > {LOGS}/strive.exit;"
                f" strive stop >/dev/null 2>&1;"
                f" cp -r {REMOTE_HOME}/sessions {LOGS}/strive-sessions 2>/dev/null; true"
            ),
            env=self._env(),
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        journal = self.logs_dir / JOURNAL
        if not journal.is_file():
            return
        tokens_in = tokens_out = cached = cost_micros = calls = 0
        ended = None
        for line in journal.read_text().splitlines():
            try:
                event = json.loads(line).get("event", {})
            except json.JSONDecodeError:
                continue
            if event.get("type") == "modelCallFinished":
                outcome = event.get("outcome", {})
                usage = outcome.get("usage") or {}
                calls += 1
                tokens_in += usage.get("input", 0)
                tokens_out += usage.get("output", 0)
                cached += usage.get("cacheRead", 0) + usage.get("cacheWrite", 0) + usage.get("cacheWriteLong", 0)
                cost_micros += outcome.get("costUsdMicros", 0)
            elif event.get("type") == "turnEnded":
                ended = event.get("reason")
        context.n_input_tokens = tokens_in
        context.n_output_tokens = tokens_out
        context.n_cache_tokens = cached
        context.cost_usd = cost_micros / 1_000_000
        exit_file = self.logs_dir / "strive.exit"
        context.metadata = {
            **(context.metadata or {}),
            "strive_model_calls": calls,
            "strive_turn_end": ended,
            "strive_exit": exit_file.read_text().strip() if exit_file.is_file() else None,
        }
