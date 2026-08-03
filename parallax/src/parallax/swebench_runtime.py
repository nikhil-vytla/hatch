from __future__ import annotations

import asyncio
import contextlib
import json
import os
import secrets
import socket
import subprocess
import tempfile
from pathlib import Path

from fastmcp import FastMCP
from hud.capabilities import Capability
from hud.environment import Environment
from hud.graders import EvaluationResult

CONFIG_PATH = Path(os.environ.get("PARALLAX_INSTANCE_PATH", "/app/instance.json"))
CONFIG = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
WORKSPACE = Path("/testbed")
env = Environment(
    name=CONFIG.get("environment_name", "parallax-unconfigured"),
    version=CONFIG.get("version", "0"),
)
workspace = env.workspace(
    WORKSPACE,
    network=False,
    track_files=True,
    shell_uid=1000,
)
_director = FastMCP(name="parallax-swebench-turn-director")
_states: dict[str, dict[str, object]] = {}
_server_task: asyncio.Task[None] | None = None


def _run(
    argv: list[str],
    *,
    cwd: Path = WORKSPACE,
    env: dict[str, str] | None = None,
    timeout: int = 900,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def reset_workspace(base_commit: str, workspace_path: Path = WORKSPACE) -> None:
    reset = _run(["git", "reset", "--hard", base_commit], cwd=workspace_path)
    clean = _run(["git", "clean", "-fdx"], cwd=workspace_path)
    if reset.returncode or clean.returncode:
        raise RuntimeError(f"workspace reset failed: {reset.stderr}{clean.stderr}")


def collect_patch(base_commit: str, workspace_path: Path = WORKSPACE) -> str:
    with tempfile.TemporaryDirectory(prefix="parallax-index-") as directory:
        index = Path(directory) / "index"
        environment = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
            "GIT_INDEX_FILE": str(index),
        }
        read_tree = _run(
            ["git", "read-tree", base_commit],
            cwd=workspace_path,
            env=environment,
        )
        if read_tree.returncode:
            raise RuntimeError(f"temporary index failed: {read_tree.stderr}")
        add = _run(["git", "add", "-A"], cwd=workspace_path, env=environment)
        if add.returncode:
            raise RuntimeError(f"candidate patch staging failed: {add.stderr}")
        diff = _run(
            ["git", "diff", "--cached", "--binary", "--full-index", base_commit],
            cwd=workspace_path,
            env=environment,
        )
        if diff.returncode:
            raise RuntimeError(f"candidate patch export failed: {diff.stderr}")
        return diff.stdout


def isolation_probe_argv() -> list[str]:
    if not workspace.bwrap_available:
        raise RuntimeError("bubblewrap is required for agent filesystem isolation")
    return workspace.shell_argv("test ! -e /app/instance.json")


@_director.tool
def advance(token: str) -> dict[str, object]:
    state = _states[token]
    turns = state["turns"]
    if not isinstance(turns, list):
        raise RuntimeError("invalid turn state")
    index = state["index"]
    if not isinstance(index, int):
        raise RuntimeError("invalid turn index")
    if index + 1 >= len(turns):
        return {"done": True, "index": index}
    index += 1
    state["index"] = index
    steps = state["agent_steps"]
    if not isinstance(steps, list):
        raise RuntimeError("invalid step state")
    return {
        "done": False,
        "index": index,
        "step_budget": steps[index],
        "turn": turns[index],
    }


def _unused_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@env.initialize
async def _verify_isolation() -> None:
    result = await asyncio.to_thread(_run, isolation_probe_argv(), cwd=WORKSPACE)
    if result.returncode:
        raise RuntimeError(
            f"agent filesystem isolation probe failed: {result.stderr.strip()}"
        )


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
async def episode(arm: str):
    scripts = CONFIG["scripts"]
    if arm not in scripts:
        raise ValueError(f"unknown arm: {arm}")
    source = CONFIG["source"]
    await asyncio.to_thread(reset_workspace, source["base_commit"])
    script = scripts[arm]
    token = secrets.token_urlsafe(24)
    _states[token] = {
        "agent_steps": script["agent_steps"],
        "index": 0,
        "turns": script["turns"],
    }
    _answer = yield json.dumps(
        {
            "arm": arm,
            "step_budget": script["agent_steps"][0],
            "token": token,
            "turn": script["turns"][0],
        },
        sort_keys=True,
    )
    final = _states.pop(token)
    patch = await asyncio.to_thread(collect_patch, source["base_commit"])
    index = final["index"]
    turns = final["turns"]
    steps = final["agent_steps"]
    if not isinstance(index, int) or not isinstance(turns, list):
        raise RuntimeError("invalid completed episode state")
    if not isinstance(steps, list) or not all(isinstance(step, int) for step in steps):
        raise RuntimeError("invalid completed budget state")
    complete = index == len(turns) - 1
    total_steps = sum(step for step in steps if isinstance(step, int))
    yield EvaluationResult(
        reward=0.0,
        content="candidate patch exported for evaluator-side official grading",
        info={
            "arm": arm,
            "final_turn": index,
            "model_patch": patch,
            "schedule_complete": complete,
            "total_agent_steps": total_steps,
            "turns": len(turns),
        },
    )
