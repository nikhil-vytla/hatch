"""HUD contract spike for a pre-registered, task-scoped turn director."""

from __future__ import annotations

import asyncio
import contextlib
import json
import socket
import tempfile
from dataclasses import dataclass
from pathlib import Path

from fastmcp import FastMCP
from hud.capabilities import Capability
from hud.environment import Environment

WORKSPACE = Path(tempfile.mkdtemp(prefix="parallax-director-spike-"))
SEALED_EPISODES = {
    "demo": (
        "Inspect the repository and report which module owns the behavior.",
        "Now propose the smallest implementation plan.",
        "Implement the requested fix and run its focused tests.",
    )
}

env = Environment(name="parallax_director_spike", version="0.1.0")
env.workspace(WORKSPACE, network=False)


@dataclass
class DirectorState:
    turns: tuple[str, ...]
    index: int = 0


_director = FastMCP(name="parallax-director")
_states: dict[str, DirectorState] = {}
_server_task: asyncio.Task[None] | None = None


@_director.tool
def current(token: str) -> dict[str, object]:
    """Return the currently revealed turn."""
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
async def episode(episode_id: str = "demo"):
    turns = SEALED_EPISODES[episode_id]
    token = f"{episode_id}:{id(turns)}"
    _states[token] = DirectorState(turns=turns)
    envelope = json.dumps({"token": token, "turn": turns[0]})
    answer = yield envelope
    final = _states[token]
    yield float(final.index == len(turns) - 1 and answer == "finished")
