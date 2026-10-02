"""strive as a Harbor installed agent.

Harbor copies Linux builds of `strive` and `strive-tui` (see
`build-linux.sh`) into the task's container and runs one headless session
there: `strive run <instruction> --json`. The container is the sandbox, so
strive's own sandbox is off and approvals are full-auto. The session's
journal is copied to the trial's agent logs, and its model calls' tokens and
exact cost are reported to Harbor.

    PYTHONPATH=bench/harbor harbor run -t hello-world/hello-world \\
        -a strive_agent:Strive -m anthropic/claude-haiku-4-5

With `--ak learn_dir=DIR`, trials learn from one another, in the order
Harbor runs them (use `-n 1`). Each trial starts from the strive home and
the learned files (`.strive/` in the task's directory) the last one left in
DIR. Before its own task, it asks the learner to study the last trial's
session, telling it only whether that task's checks passed, and accepts the
proposals that pass strive's gates, as a person reviewing them would.
"""

import json
import os
import re
import shlex
import tempfile
import time
import tomllib
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

STRIVE_ROOT = Path(__file__).resolve().parents[2]
REMOTE_BIN = "/opt/strive"
REMOTE_HOME = "/tmp/strive-home"
LOGS = "/logs/agent"
JOURNAL = "strive.jsonl"
LEARNER = "learner.jsonl"
# What a trial leaves for the next, in its logs and in `learn_dir`.
STATE = "strive-state.tgz"
LAST = "last.json"
# Where the learned files (a task directory's `.strive/`) wait between
# trials: tasks run in different directories, so not under any of them.
CARRIED = "/tmp/strive-learned"

# Left of the agent's time for saving what this trial learned, after its task.
SAVE_SECONDS = 90

# What the learner is told about the last trial: its outcome, not its tests.
PASSED = "An automated check of this session's task found it done: the task's own tests passed."
FAILED = (
    "An automated check of this session's task found it not done: the task's own tests failed, "
    "though the session ended as if it had finished."
)


def journal_events(path: Path) -> list[dict]:
    """The events in `strive run --json`'s output (an entry per line) or `strive log --json`'s (one object)."""
    if not path.is_file():
        return []
    text = path.read_text()
    try:
        whole = json.loads(text)
    except json.JSONDecodeError:
        whole = None
    if isinstance(whole, dict) and isinstance(whole.get("entries"), list):
        entries = whole["entries"]
    else:
        entries = []
        for line in text.splitlines():
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return [e["event"] for e in entries if isinstance(e, dict) and isinstance(e.get("event"), dict)]


def since_last_request(events: list[dict]) -> list[dict]:
    """A learning session's events from its latest `learnRequested` on: the learner's last run."""
    starts = [i for i, e in enumerate(events) if e.get("type") == "learnRequested"]
    return events[starts[-1] :] if starts else []


def journal_usage(events: list[dict]) -> dict:
    """Model calls, tokens and exact cost in a journal's events, and how its last turn ended."""
    usage = {"calls": 0, "input": 0, "output": 0, "cached": 0, "cost_micros": 0, "turn_end": None}
    for event in events:
        if event.get("type") == "modelCallFinished":
            outcome = event.get("outcome", {})
            tokens = outcome.get("usage") or {}
            usage["calls"] += 1
            usage["input"] += tokens.get("input", 0)
            usage["output"] += tokens.get("output", 0)
            usage["cached"] += tokens.get("cacheRead", 0) + tokens.get("cacheWrite", 0) + tokens.get("cacheWriteLong", 0)
            usage["cost_micros"] += outcome.get("costUsdMicros", 0)
        elif event.get("type") == "turnEnded":
            usage["turn_end"] = event.get("reason")
    return usage


class Strive(BaseInstalledAgent):
    """One strive session per trial.

    Agent kwargs (`--ak`):
    - `budget_usd`: each task's spending limit (default 2).
    - `learner_budget_usd`: the learner's, for all its runs together, since
      its session carries from trial to trial (default 3).
    - `binaries`: a directory holding `strive` and `strive-tui` per
      architecture, as `linux-arm64` and `linux-amd64` (default strive's
      `target`).
    - `learn_dir`: see the module's note. Without it, nothing is learned
      from one trial to the next.
    """

    def __init__(
        self,
        logs_dir: Path,
        budget_usd: float | str = 2.0,
        learner_budget_usd: float | str = 3.0,
        binaries: str | None = None,
        learn_dir: str | None = None,
        **kwargs,
    ):
        super().__init__(logs_dir, **kwargs)
        self.budget_usd = float(budget_usd)
        self.learner_budget_usd = float(learner_budget_usd)
        self.binaries = Path(binaries) if binaries else STRIVE_ROOT / "target"
        self.learn_dir = Path(learn_dir).expanduser().resolve() if learn_dir else None
        self._workspace: str | None = None
        self._session: str | None = None
        self._learned: list[dict] = []

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
            # New sessions' limit: the learner's. Each task's own is given to `strive run`.
            "budget": {"usd": self.learner_budget_usd},
            # The learner runs only when this adapter asks it to.
            "learning": {"mode": "off", "ask": False},
        }
        if model := self._model():
            settings["model"] = model
        return settings

    def _agent_seconds(self) -> float | None:
        """This trial's agent time limit, from its task and its job's multipliers; None if unknown."""
        try:
            trial = json.loads((self.logs_dir.parent / "config.json").read_text())
            task = tomllib.loads((Path(trial["task"]["path"]) / "task.toml").read_text())
            seconds = float(task["agent"]["timeout_sec"])
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError, tomllib.TOMLDecodeError):
            return None
        try:
            job = json.loads((self.logs_dir.parent.parent / "config.json").read_text())
        except (OSError, json.JSONDecodeError):
            job = {}
        multiplier = job.get("agent_timeout_multiplier") or job.get("timeout_multiplier") or 1.0
        return seconds * float(multiplier)

    def _last(self) -> dict | None:
        """The last trial's session and its trial directory, if a trial left them."""
        if self.learn_dir is None or not (self.learn_dir / LAST).is_file():
            return None
        return json.loads((self.learn_dir / LAST).read_text())

    async def install(self, environment: BaseEnvironment) -> None:
        machine = (await self.exec_as_root(environment, command="uname -m")).stdout.strip()
        arch = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64"}.get(machine)
        if arch is None:
            raise RuntimeError(f"strive has no Linux build for {machine}")
        built = self.binaries / f"linux-{arch}"
        for exe in ("strive", "strive-tui"):
            if not (built / exe).is_file():
                raise RuntimeError(f"{built / exe} is missing; run bench/harbor/build-linux.sh {arch}")
        self._workspace = (await self.exec_as_agent(environment, command="pwd")).stdout.strip()
        await self.exec_as_root(environment, command=f"mkdir -p {REMOTE_BIN} {REMOTE_HOME}")
        for exe in ("strive", "strive-tui"):
            await environment.upload_file(built / exe, f"{REMOTE_BIN}/{exe}")
        if self.learn_dir is not None and (self.learn_dir / STATE).is_file():
            # The home (its key, sessions and the learner's journal) and the learned files.
            await environment.upload_file(self.learn_dir / STATE, f"/tmp/{STATE}")
            await self.exec_as_root(environment, command=f"tar xzf /tmp/{STATE} -C / && rm /tmp/{STATE}")
        with tempfile.TemporaryDirectory(prefix="strive-harbor-") as tmp:
            settings = Path(tmp) / "settings.json"
            settings.write_text(json.dumps(self._settings(), indent=2))
            await environment.upload_file(settings, f"{REMOTE_HOME}/settings.json")
        ws = shlex.quote(self._workspace)
        carry = (
            f" && if [ -d {CARRIED} ]; then rm -rf {ws}/.strive && cp -r {CARRIED} {ws}/.strive; fi"
            if self.learn_dir is not None
            else ""
        )
        # Learned files stay out of a task's git status, which some tasks check.
        exclude = (
            f" && if [ -d {ws}/.git ]; then grep -qx '.strive/' {ws}/.git/info/exclude 2>/dev/null"
            f" || echo '.strive/' >> {ws}/.git/info/exclude; fi"
        )
        owner = environment.default_user
        chown = (
            f" && chown -R {shlex.quote(str(owner))} {REMOTE_HOME}"
            f" && if [ -d {ws}/.strive ]; then chown -R {shlex.quote(str(owner))} {ws}/.strive; fi"
            if owner is not None
            else ""
        )
        await self.exec_as_root(
            environment,
            command=f"chmod 755 {REMOTE_BIN}/strive {REMOTE_BIN}/strive-tui{carry}{exclude}{chown}",
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

    async def _strive(self, environment: BaseEnvironment, command: str, cwd: str | None = None) -> str:
        """Runs a strive command in the task's directory (or `cwd`); its output, whatever its exit."""
        result = await self.exec_as_agent(
            environment,
            command=f"{command} 2>&1; echo \"[exit $?]\"",
            env=self._env(),
            cwd=cwd or self._workspace,
        )
        return result.stdout or ""

    @staticmethod
    def _json(output: str):
        """What a `--json` command printed, before the exit line `_strive` adds; None if it isn't JSON."""
        body = output.rsplit("[exit ", 1)[0]
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return None

    async def _learn(self, environment: BaseEnvironment, last: dict) -> None:
        """The learner on the last trial's session, told its outcome; what passed the gates, accepted.

        strive learns per project directory and the learner studies only
        that directory's sessions, so it runs where the last task did. If
        that directory isn't in this task's container, it is made for the
        learner, with the learned files, and removed after, so it can't
        change what this task's checks see.
        """
        reward = Path(last["trial_dir"]) / "verifier" / "reward.txt"
        passed = reward.is_file() and float(reward.read_text().strip() or 0) >= 1.0
        note = PASSED if passed else FAILED
        there = last.get("cwd") or self._workspace or "/"
        elsewhere = there != self._workspace
        created = ""
        if elsewhere:
            made = await self.exec_as_root(
                environment,
                command=(
                    f"p={shlex.quote(there)}; top=$p; while [ ! -d \"$(dirname \"$top\")\" ]; do top=$(dirname \"$top\"); done;"
                    f" if [ -d \"$p\" ]; then echo; else mkdir -p \"$p\" && echo \"$top\"; fi;"
                    f" rm -rf \"$p/.strive\"; if [ -d {CARRIED} ]; then cp -r {CARRIED} \"$p/.strive\"; fi"
                ),
            )
            created = (made.stdout or "").strip()
        out = await self._strive(
            environment,
            f"strive learn --session {shlex.quote(last['session'])} --note {shlex.quote(note)}",
            cwd=there,
        )
        (self.logs_dir / "learner.out").write_text(out)
        if found := re.search(r"strive log ([0-9A-Z]{26})", out):
            await self._strive(environment, f"strive log {found.group(1)} --json > {LOGS}/{LEARNER}")
        listed = self._json(await self._strive(environment, "strive review --json", cwd=there))
        proposals = listed.get("proposals", []) if isinstance(listed, dict) else []
        for p in proposals:
            if p.get("status") != "ready":
                continue
            decided = await self._strive(environment, f"strive review {int(p['id'])} accept", cwd=there)
            self._learned.append(
                {
                    "proposal": p["id"],
                    "summary": p.get("proposal", {}).get("summary"),
                    "artifact": p.get("proposal", {}).get("artifact"),
                    "accepted": "[exit 0]" in decided,
                    "after": "passed" if passed else "failed",
                }
            )
        if elsewhere:
            ws, p = shlex.quote(self._workspace or "/"), shlex.quote(there)
            # What the learner left there is this task's learned files now.
            remove = f" && rm -rf {shlex.quote(created)}" if created else ""
            await self.exec_as_root(
                environment,
                command=f"rm -rf {ws}/.strive; if [ -d {p}/.strive ]; then cp -r {p}/.strive {ws}/.strive; fi{remove}",
            )

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        started = time.monotonic()
        if last := self._last():
            await self._learn(environment, last)
        # A task that runs out of time is interrupted before Harbor's limit,
        # so what this trial learned is still saved for the next.
        limit = ""
        if self.learn_dir is not None and (seconds := self._agent_seconds()):
            left = int(seconds - (time.monotonic() - started) - SAVE_SECONDS)
            limit = f"timeout -s INT -k 30 {max(left, 30)} "
        await self._strive(
            environment,
            f"{limit}strive run {shlex.quote(instruction)} --approvals full-auto"
            f" --budget {self.budget_usd} --json > {LOGS}/{JOURNAL} 2> {LOGS}/strive.stderr;"
            f" echo $? > {LOGS}/strive.exit",
        )
        # Newest first: the session this trial's task just ran in.
        listed = self._json(await self._strive(environment, "strive sessions --json"))
        self._session = listed[0]["id"] if isinstance(listed, list) and listed else None
        learned = shlex.quote(f"{self._workspace or ''}/.strive")
        # Stopped first, so the journals are whole; the socket is left behind.
        await self._strive(
            environment,
            f"strive stop >/dev/null; cp -r {REMOTE_HOME}/sessions {LOGS}/strive-sessions;"
            f" rm -rf {CARRIED}; if [ -d {learned} ]; then cp -r {learned} {CARRIED}; fi;"
            f" cd / && paths=tmp/strive-home && if [ -d {CARRIED} ]; then paths=\"$paths {CARRIED.lstrip('/')}\"; fi"
            f" && tar czf {LOGS}/{STATE} --exclude=tmp/strive-home/run $paths",
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        task = journal_usage(journal_events(self.logs_dir / JOURNAL))
        learner = journal_usage(since_last_request(journal_events(self.logs_dir / LEARNER)))
        context.n_input_tokens = task["input"] + learner["input"]
        context.n_output_tokens = task["output"] + learner["output"]
        context.n_cache_tokens = task["cached"] + learner["cached"]
        context.cost_usd = (task["cost_micros"] + learner["cost_micros"]) / 1_000_000
        exit_file = self.logs_dir / "strive.exit"
        context.metadata = {
            **(context.metadata or {}),
            "strive_model_calls": task["calls"],
            "strive_turn_end": task["turn_end"],
            "strive_exit": exit_file.read_text().strip() if exit_file.is_file() else None,
            "strive_task_cost_usd": task["cost_micros"] / 1_000_000,
            "strive_learner_cost_usd": learner["cost_micros"] / 1_000_000,
            "strive_learned": self._learned,
        }
        state = self.logs_dir / STATE
        if self.learn_dir is not None and state.is_file() and self._session:
            self.learn_dir.mkdir(parents=True, exist_ok=True)
            (self.learn_dir / STATE).write_bytes(state.read_bytes())
            (self.learn_dir / LAST).write_text(
                json.dumps(
                    {"session": self._session, "trial_dir": str(self.logs_dir.parent), "cwd": self._workspace},
                    indent=2,
                )
            )
