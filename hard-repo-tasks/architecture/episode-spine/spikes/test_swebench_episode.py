"""Contract tests for one real SWE-bench task across matched intent arms."""

from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace
from typing import Any

import pytest
from hud.agents.base import Agent
from hud.eval.runtime import DockerRuntime
from hud.eval.task import Task
from minisweagent.agents.default import DefaultAgent
from test_hud_spikes import SyncHudShellBridge

IMAGE = os.environ.get("PARALLAX_SWEBENCH_IMAGE")
ARMS = ("static", "matched", "evolved")
ENVIRONMENT = "parallax-swebench-django-11099"


class GoldActionModel:
    """Apply the gold semantic edit only when the terminal intent arrives."""

    config = SimpleNamespace()

    def __init__(self, *, apply_fix: bool = True) -> None:
        self.apply_fix = apply_fix

    def query(self, messages: list[dict[str, Any]], **kwargs: Any) -> dict[str, Any]:
        turn = next(
            message["content"]
            for message in reversed(messages)
            if message["role"] == "user"
        )
        intermediate = (
            "Do not edit yet" in turn
            or "First inspect" in turn
            or "Propose the smallest implementation" in turn
        )
        if self.apply_fix and not intermediate:
            command = (
                "python -c 'from pathlib import Path; "
                'p=Path("django/contrib/auth/validators.py"); '
                "s=p.read_text(); old=\"r\\047^[\\\\w.@+-]+$\\047\"; "
                "new=\"r\\047^[\\\\w.@+-]+\\\\Z\\047\"; "
                "assert s.count(old)==2; p.write_text(s.replace(old,new))'"
            )
        else:
            command = "git status --short && python -m py_compile django/contrib/auth/validators.py"
        return {
            "role": "assistant",
            "content": "execute scheduled action",
            "extra": {"actions": [{"command": command}], "cost": 0.0},
        }

    def format_message(self, **kwargs: Any) -> dict[str, Any]:
        return dict(kwargs)

    def format_observation_messages(
        self,
        message: dict[str, Any],
        outputs: list[dict[str, Any]],
        template_vars: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        assert outputs[0]["returncode"] == 0, outputs[0]["output"]
        return [{"role": "tool", "content": outputs[0]["output"], "extra": {}}]

    def get_template_vars(self, **kwargs: Any) -> dict[str, Any]:
        return kwargs

    def serialize(self) -> dict[str, Any]:
        return {"info": {"model_type": type(self).__name__}}


class SweBenchEpisodeProbe(Agent):
    """Drive one arm through a persistent mini-swe-agent conversation."""

    def __init__(self, *, apply_fix: bool = True) -> None:
        self.apply_fix = apply_fix

    async def __call__(self, run) -> None:
        opening = json.loads(run.prompt_text)
        arm = opening["arm"]
        assert arm in ARMS
        if arm == "evolved":
            assert "trailing newline" not in opening["turn"]

        director = await run.client.open("director")
        ssh = await run.client.open("ssh")
        bridge = SyncHudShellBridge(ssh, asyncio.get_running_loop())
        mini_agent = DefaultAgent(
            GoldActionModel(apply_fix=self.apply_fix),
            bridge,
            system_template="",
            instance_template="",
        )
        mini_agent.add_messages({"role": "system", "content": "", "extra": {}})

        turn = opening["turn"]
        index = 0
        while True:
            mini_agent.add_messages({"role": "user", "content": turn, "extra": {}})
            await asyncio.to_thread(mini_agent.step)
            revealed = await director.call_tool("advance", {"token": opening["token"]})
            if revealed.structuredContent["done"]:
                break
            index = revealed.structuredContent["index"]
            turn = revealed.structuredContent["turn"]

        expected_calls = 1 if arm == "static" else 3
        assert mini_agent.n_calls == expected_calls
        assert index == expected_calls - 1
        run.trace.content = "finished"


async def _run_arm(arm: str, *, apply_fix: bool) -> float:
    task = Task(env=ENVIRONMENT, id="episode", args={"arm": arm})
    job = await task.run(
        SweBenchEpisodeProbe(apply_fix=apply_fix),
        runtime=DockerRuntime(IMAGE),
    )
    assert len(job.runs) == 1
    run = job.runs[0]
    assert run.evaluation["info"]["arm"] == arm
    assert run.evaluation["info"]["instance_id"] == "django__django-11099"
    return run.reward


@pytest.mark.skipif(not IMAGE, reason="set PARALLAX_SWEBENCH_IMAGE")
def test_gold_fix_passes_all_intent_arms() -> None:
    async def run_all() -> None:
        rewards = [await _run_arm(arm, apply_fix=True) for arm in ARMS]
        assert rewards == [1.0, 1.0, 1.0]

    asyncio.run(run_all())


@pytest.mark.skipif(not IMAGE, reason="set PARALLAX_SWEBENCH_IMAGE")
def test_no_op_fails_official_verifier() -> None:
    assert asyncio.run(_run_arm("static", apply_fix=False)) == 0.0
