from __future__ import annotations

import json
from pathlib import Path

from .runner import atomic_write
from .swebench import SweScriptFamily
from .types import StrictModel

HUD_VERSION = "0.6.12"


class UnsafeVerifierIsolationError(RuntimeError):
    pass


ENVIRONMENT_SOURCE = """from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import socket
import subprocess
from pathlib import Path

from fastmcp import FastMCP
from hud.capabilities import Capability
from hud.environment import Environment
from hud.graders import EvaluationResult

CONFIG = json.loads(Path("/app/instance.json").read_text())
WORKSPACE = Path("/testbed")
env = Environment(name=CONFIG["environment_name"], version=CONFIG["version"])
env.workspace(WORKSPACE, network=False, track_files=True)
_director = FastMCP(name="parallax-swebench-turn-director")
_states = {}
_server_task = None


def _run(argv, *, input_text=None, timeout=900):
    return subprocess.run(
        argv,
        cwd=WORKSPACE,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def _reset():
    base = CONFIG["source"]["base_commit"]
    reset = _run(["git", "reset", "--hard", base])
    clean = _run(["git", "clean", "-fdx"])
    if reset.returncode or clean.returncode:
        raise RuntimeError(f"workspace reset failed: {reset.stderr}{clean.stderr}")


def _test_paths(patch):
    return tuple(
        line[6:]
        for line in patch.splitlines()
        if line.startswith("+++ b/")
    )


def _grade():
    source = CONFIG["source"]
    verifier = CONFIG["verifier"]
    base = source["base_commit"]
    changed = _run(["git", "diff", "--name-only", base])
    if changed.returncode:
        return EvaluationResult(reward=0.0, content="invalid git state")
    changed_paths = tuple(sorted(filter(None, changed.stdout.splitlines())))
    if not changed_paths:
        return EvaluationResult(
            reward=0.0,
            content="invalid submission: no tracked changes",
            info={"changed_paths": changed_paths},
        )
    test_paths = _test_paths(verifier["test_patch"])
    if test_paths:
        restore = _run(["git", "checkout", base, "--", *test_paths])
        if restore.returncode:
            return EvaluationResult(
                reward=0.0,
                content="failed to restore sealed test files",
            )
    applied = _run(["git", "apply", "-"], input_text=verifier["test_patch"])
    if applied.returncode:
        return EvaluationResult(
            reward=0.0,
            content="failed to apply sealed test patch",
        )
    try:
        result = _run(verifier["test_command"])
    finally:
        if test_paths:
            _run(["git", "checkout", base, "--", *test_paths])
    passed = result.returncode == 0
    return EvaluationResult(
        reward=float(passed),
        content="official verifier passed" if passed else "official verifier failed",
        info={
            "changed_paths": changed_paths,
            "fail_to_pass": len(verifier["fail_to_pass"]),
            "instance_id": source["instance_id"],
            "pass_to_pass": len(verifier["pass_to_pass"]),
            "returncode": result.returncode,
            "verifier_digest": verifier["digest"],
        },
    )


@_director.tool
def advance(token):
    state = _states[token]
    if state["index"] + 1 >= len(state["turns"]):
        return {"done": True, "index": state["index"]}
    state["index"] += 1
    index = state["index"]
    return {
        "done": False,
        "index": index,
        "step_budget": state["agent_steps"][index],
        "turn": state["turns"][index],
    }


def _unused_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@env.initialize
async def _start_director():
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
async def _stop_director():
    if _server_task is not None:
        _server_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await _server_task


@env.template(id="episode")
async def episode(arm):
    scripts = CONFIG["scripts"]
    if arm not in scripts:
        raise ValueError(f"unknown arm: {arm}")
    await asyncio.to_thread(_reset)
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
    grade = await asyncio.to_thread(_grade)
    complete = final["index"] == len(final["turns"]) - 1
    yield EvaluationResult(
        reward=grade.reward if complete else 0.0,
        content=grade.content if complete else "episode ended before final intent",
        info={
            **(grade.info or {}),
            "arm": arm,
            "final_turn": final["index"],
            "total_agent_steps": sum(final["agent_steps"]),
            "turns": len(final["turns"]),
        },
        subscores=grade.subscores,
    )
"""


class EnvironmentBundle(StrictModel):
    instance_json: bytes
    env_py: bytes
    dockerfile: bytes

    def write(self, directory: Path) -> None:
        atomic_write(directory / "instance.json", self.instance_json)
        atomic_write(directory / "env.py", self.env_py)
        atomic_write(directory / "Dockerfile.hud", self.dockerfile)


def render_environment(
    family: SweScriptFamily,
    *,
    allow_unsafe_embedded_verifier: bool = False,
) -> EnvironmentBundle:
    if not allow_unsafe_embedded_verifier:
        raise UnsafeVerifierIsolationError(
            "embedded verifier is agent-readable; evaluator-side isolation required"
        )
    problem = family.static.problem
    verifier = problem.verifier
    instance = {
        "environment_name": f"parallax-{problem.instance_id}",
        "source": {
            "base_commit": problem.base_commit,
            "dataset": problem.dataset,
            "dataset_revision": problem.dataset_revision,
            "instance_id": problem.instance_id,
            "problem_statement": problem.problem_statement,
            "public_digest": problem.public_digest,
            "repo": problem.repo,
            "version": problem.version,
        },
        "scripts": {
            script.arm: {
                "agent_steps": script.agent_steps,
                "max_output_tokens": script.max_output_tokens,
                "turns": tuple(turn.text for turn in script.turns),
            }
            for script in family.scripts
        },
        "verifier": {
            "digest": verifier.digest,
            "fail_to_pass": verifier.fail_to_pass,
            "harness_revision": verifier.harness_revision,
            "image_digest": verifier.image_digest,
            "pass_to_pass": verifier.pass_to_pass,
            "test_command": verifier.test_command,
            "test_patch": verifier.test_patch,
        },
        "version": "0.2.0",
    }
    instance_json = (
        json.dumps(
            instance,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode()
        + b"\n"
    )
    dockerfile = (
        "FROM --platform=linux/amd64 "
        f"{verifier.image_ref}@sha256:{verifier.image_digest}\n\n"
        "RUN /opt/miniconda3/bin/python -m pip install --no-cache-dir "
        f'"hud=={HUD_VERSION}"\n\n'
        "WORKDIR /app\n"
        "COPY env.py instance.json /app/\n\n"
        "EXPOSE 8765\n"
        'CMD ["hud", "serve", "env.py", "--host", "0.0.0.0", "--port", "8765"]\n'
    ).encode()
    return EnvironmentBundle(
        instance_json=instance_json,
        env_py=ENVIRONMENT_SOURCE.encode(),
        dockerfile=dockerfile,
    )
