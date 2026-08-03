"""Deployable persistent multi-turn HUD environment."""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import socket
import tempfile
from dataclasses import dataclass
from pathlib import Path

from fastmcp import FastMCP
from hud.capabilities import Capability
from hud.environment import Environment
from hud.graders import EvaluationResult

EPISODES = {
    "persistent-write": (
        "Append a line containing alpha to state.txt.",
        "Now append a line containing beta to the same file.",
        "Finally append a line containing gamma without removing prior work.",
    )
}
EXPECTED_STATE = "seed\nalpha\nbeta\ngamma\n"
WORKSPACE = Path(tempfile.mkdtemp(prefix="parallax-docker-episode-"))

env = Environment(name="parallax-episode-spine", version="0.1.0")
env.workspace(WORKSPACE, network=False, track_files=True)


@dataclass
class DirectorState:
    turns: tuple[str, ...]
    index: int = 0


_director = FastMCP(name="parallax-turn-director")
_states: dict[str, DirectorState] = {}
_server_task: asyncio.Task[None] | None = None


@_director.tool
def current(token: str) -> dict[str, object]:
    """Return only the currently revealed turn."""
    state = _states[token]
    return {"index": state.index, "turn": state.turns[state.index]}


@_director.tool
def advance(token: str) -> dict[str, object]:
    """Reveal exactly one subsequent turn."""
    state = _states[token]
    if state.index + 1 >= len(state.turns):
        return {"done": True, "index": state.index}
    state.index += 1
    return {"done": False, "index": state.index, "turn": state.turns[state.index]}


def _unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@env.initialize
async def _start_director() -> None:
    global _server_task
    port = _unused_port()
    _server_task = asyncio.create_task(
        _director.run_http_async(
            show_banner=False,
            host="127.0.0.1",
            port=port,
            log_level="error",
        )
    )
    env.add_capability(
        Capability.mcp(name="director", url=f"http://127.0.0.1:{port}/mcp")
    )
    await asyncio.sleep(0.2)


@env.shutdown
async def _stop_director() -> None:
    if _server_task is not None:
        _server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _server_task


@env.template(id="episode")
async def episode(episode_id: str = "persistent-write"):
    turns = EPISODES[episode_id]
    token = secrets.token_urlsafe(24)
    _states[token] = DirectorState(turns=turns)
    (WORKSPACE / "state.txt").write_text("seed\n")

    _answer = yield json.dumps({"token": token, "turn": turns[0]})

    final = _states.pop(token)
    actual_state = (WORKSPACE / "state.txt").read_text()
    passed = final.index == len(turns) - 1 and actual_state == EXPECTED_STATE
    yield EvaluationResult(
        reward=float(passed),
        content="persistent episode passed" if passed else "persistent episode failed",
        info={
            "final_turn": final.index,
            "state": actual_state,
            "turns": len(turns),
        },
    )
