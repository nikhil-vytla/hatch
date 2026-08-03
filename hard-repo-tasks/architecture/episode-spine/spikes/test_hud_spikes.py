"""Executable checks for the two load-bearing HUD integration assumptions."""

from __future__ import annotations

import asyncio
import json
import shlex
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from director_env import episode
from hud.agents.base import Agent
from hud.eval.runtime import LocalRuntime
from minisweagent.agents.default import DefaultAgent


class SyncHudShellBridge:
    """mini-swe-agent-shaped synchronous execute over HUD's async SSH client."""

    def __init__(self, ssh: Any, loop: asyncio.AbstractEventLoop) -> None:
        self._ssh = ssh
        self._loop = loop
        self._event_loop_thread = threading.get_ident()

    async def _execute(
        self,
        command: str,
        cwd: str,
        timeout: int | None,
    ) -> dict[str, Any]:
        mapped_cwd = self._ssh.map_path(cwd or "/")
        result = await self._ssh.conn.run(
            f"cd {shlex.quote(mapped_cwd)} && {command}",
            check=False,
            timeout=timeout,
        )
        return {
            "output": f"{result.stdout or ''}{result.stderr or ''}",
            "returncode": result.returncode,
            "exception_info": "",
        }

    def execute(
        self,
        action: dict[str, Any],
        cwd: str = "",
        *,
        timeout: int | None = None,
    ) -> dict[str, Any]:
        if threading.get_ident() == self._event_loop_thread:
            raise RuntimeError("synchronous bridge must run outside the HUD event-loop thread")
        future = asyncio.run_coroutine_threadsafe(
            self._execute(str(action.get("command", "")), cwd, timeout),
            self._loop,
        )
        return future.result(timeout=None if timeout is None else timeout + 1)

    def get_template_vars(self, **kwargs: Any) -> dict[str, Any]:
        return {"cwd": ".", **kwargs}

    def serialize(self) -> dict[str, Any]:
        return {"info": {"environment_type": type(self).__name__}}


class OneActionModel:
    """Minimal real mini-swe-agent Model implementation for the bridge spike."""

    config = SimpleNamespace()

    def query(self, messages: list[dict[str, Any]], **kwargs: Any) -> dict[str, Any]:
        return {
            "role": "assistant",
            "content": "run one command",
            "extra": {
                "actions": [{"command": "printf mini-swe"}],
                "cost": 0.0,
            },
        }

    def format_message(self, **kwargs: Any) -> dict[str, Any]:
        return dict(kwargs)

    def format_observation_messages(
        self,
        message: dict[str, Any],
        outputs: list[dict[str, Any]],
        template_vars: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        return [{"role": "tool", "content": outputs[0]["output"], "extra": {}}]

    def get_template_vars(self, **kwargs: Any) -> dict[str, Any]:
        return kwargs

    def serialize(self) -> dict[str, Any]:
        return {"info": {"model_type": type(self).__name__}}


class DirectorProbeAgent(Agent):
    """Exercise hidden turn reveal and concurrent synchronous shell calls."""

    async def __call__(self, run) -> None:
        opening = json.loads(run.prompt_text)
        assert opening["turn"].startswith("Inspect")
        assert "Implement the requested fix" not in run.prompt_text

        director = await run.client.open("director")
        current = await director.call_tool("current", {"token": opening["token"]})
        assert current.structuredContent == {
            "index": 0,
            "turn": opening["turn"],
        }

        first = await director.call_tool("advance", {"token": opening["token"]})
        second = await director.call_tool("advance", {"token": opening["token"]})
        assert first.structuredContent["index"] == 1
        assert second.structuredContent["index"] == 2
        assert second.structuredContent["turn"].startswith("Implement")

        ssh = await run.client.open("ssh")
        bridge = SyncHudShellBridge(ssh, asyncio.get_running_loop())
        results = await asyncio.gather(
            asyncio.to_thread(
                bridge.execute,
                {"command": "printf first"},
                ".",
                timeout=5,
            ),
            asyncio.to_thread(
                bridge.execute,
                {"command": "printf second"},
                ".",
                timeout=5,
            ),
        )
        assert sorted(result["output"] for result in results) == ["first", "second"]
        assert all(result["returncode"] == 0 for result in results)

        mini_agent = DefaultAgent(
            OneActionModel(),
            bridge,
            system_template="",
            instance_template="",
        )
        messages = await asyncio.to_thread(mini_agent.step)
        assert messages[-1]["content"] == "mini-swe"
        run.trace.content = "finished"


def test_preregistered_director_and_sync_ssh_bridge() -> None:
    async def run_probe() -> None:
        source = Path(__file__).with_name("director_env.py")
        task = episode(episode_id="demo")
        job = await task.run(DirectorProbeAgent(), runtime=LocalRuntime(source))
        assert job.runs[0].reward == 1.0

    asyncio.run(run_probe())
