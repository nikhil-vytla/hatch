"""Docker proof for one persistent HUD run and mini-swe-agent conversation."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from hud.agents.base import Agent
from hud.eval.runtime import DockerRuntime, HUDRuntime
from minisweagent.agents.default import DefaultAgent
from test_hud_spikes import SyncHudShellBridge

ENV_SOURCE = Path(__file__).parents[1] / "environment" / "env.py"
ENV_SPEC = importlib.util.spec_from_file_location("parallax_episode_environment", ENV_SOURCE)
assert ENV_SPEC is not None and ENV_SPEC.loader is not None
ENV_MODULE = importlib.util.module_from_spec(ENV_SPEC)
sys.modules[ENV_SPEC.name] = ENV_MODULE
ENV_SPEC.loader.exec_module(ENV_MODULE)
EPISODES = ENV_MODULE.EPISODES
episode = ENV_MODULE.episode

IMAGE = os.environ.get("PARALLAX_DOCKER_IMAGE")
HOSTED = os.environ.get("PARALLAX_HOSTED") == "1"


class TurnActionModel:
    """Deterministic model that maps each revealed intent to one shell action."""

    config = SimpleNamespace()

    def query(self, messages: list[dict[str, Any]], **kwargs: Any) -> dict[str, Any]:
        turn = next(
            message["content"]
            for message in reversed(messages)
            if message["role"] == "user"
        )
        line = {
            EPISODES["persistent-write"][0]: "alpha",
            EPISODES["persistent-write"][1]: "beta",
            EPISODES["persistent-write"][2]: "gamma",
        }[turn]
        return {
            "role": "assistant",
            "content": f"append {line}",
            "extra": {
                "actions": [{"command": f"printf '{line}\\n' >> state.txt"}],
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


class PersistentEpisodeProbe(Agent):
    """Drive all scheduled turns through one mini-swe-agent instance."""

    async def __call__(self, run) -> None:
        opening = json.loads(run.prompt_text)
        turns = EPISODES["persistent-write"]
        assert opening["turn"] == turns[0]
        assert "beta" not in run.prompt_text
        assert "gamma" not in run.prompt_text

        director = await run.client.open("director")
        ssh = await run.client.open("ssh")
        bridge = SyncHudShellBridge(ssh, asyncio.get_running_loop())
        mini_agent = DefaultAgent(
            TurnActionModel(),
            bridge,
            system_template="",
            instance_template="",
        )
        mini_agent.add_messages({"role": "system", "content": "", "extra": {}})

        observed_states: list[str] = []
        for index, expected_turn in enumerate(turns):
            if index == 0:
                turn = opening["turn"]
            else:
                revealed = await director.call_tool("advance", {"token": opening["token"]})
                assert revealed.structuredContent["index"] == index
                turn = revealed.structuredContent["turn"]
            assert turn == expected_turn
            mini_agent.add_messages({"role": "user", "content": turn, "extra": {}})
            await asyncio.to_thread(mini_agent.step)
            state = await asyncio.to_thread(
                bridge.execute,
                {
                    "command": "python -c 'from pathlib import Path; "
                    'print(Path("state.txt").read_text(), end="")\''
                },
                ".",
                timeout=5,
            )
            assert state["returncode"] == 0
            observed_states.append(state["output"])

        done = await director.call_tool("advance", {"token": opening["token"]})
        assert done.structuredContent == {"done": True, "index": 2}
        assert observed_states == [
            "seed\nalpha\n",
            "seed\nalpha\nbeta\n",
            "seed\nalpha\nbeta\ngamma\n",
        ]
        assert mini_agent.n_calls == 3
        user_turns = [
            message["content"]
            for message in mini_agent.messages
            if message["role"] == "user"
        ]
        assert user_turns == list(turns)
        run.trace.content = "finished"


async def _run_probe(runtime: Any) -> None:
    task = episode(episode_id="persistent-write")
    assert task.env == "parallax-episode-spine"
    job = await task.run(PersistentEpisodeProbe(), runtime=runtime)
    assert len(job.runs) == 1
    assert job.runs[0].reward == 1.0
    assert job.runs[0].evaluation["info"] == {
        "final_turn": 2,
        "state": "seed\nalpha\nbeta\ngamma\n",
        "turns": 3,
    }


@pytest.mark.skipif(not IMAGE, reason="set PARALLAX_DOCKER_IMAGE to a built spike image")
def test_persistent_episode_in_docker() -> None:
    asyncio.run(_run_probe(DockerRuntime(IMAGE)))


@pytest.mark.skipif(not HOSTED, reason="set PARALLAX_HOSTED=1 to use HUDRuntime")
def test_persistent_episode_on_hud() -> None:
    assert os.environ.get("HUD_TELEMETRY_ENABLED", "true").lower() not in {
        "0",
        "false",
        "no",
    }, "HUDRuntime tunnel authorization requires a platform-visible rollout trace"
    asyncio.run(_run_probe(HUDRuntime(run_timeout=300)))
