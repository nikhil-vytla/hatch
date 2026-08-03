from __future__ import annotations

import asyncio
import json
import os
import subprocess
import tempfile
from pathlib import Path

from hud.environment import Answer, Environment
from hud.graders import EvaluationResult

from .delivery import CompleteDeliveryReceiptV1

CONFIG_PATH = Path(os.environ.get("PARALLAX_INSTANCE_PATH", "/app/instance.json"))
CONFIG = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}
WORKSPACE = Path("/testbed")
WORKSPACE_UID = 1000
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


def workspace_owner_argv(
    argv: list[str],
    *,
    effective_uid: int | None = None,
) -> list[str]:
    uid = os.geteuid() if effective_uid is None else effective_uid
    if uid != 0:
        return argv
    return [
        "/usr/bin/setpriv",
        "--reuid",
        str(WORKSPACE_UID),
        "--regid",
        str(WORKSPACE_UID),
        "--clear-groups",
        "--",
        *argv,
    ]


def _run(
    argv: list[str],
    *,
    cwd: Path = WORKSPACE,
    env: dict[str, str] | None = None,
    timeout: int = 900,
    as_workspace_owner: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        workspace_owner_argv(argv) if as_workspace_owner else argv,
        cwd=cwd,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )


def reset_workspace(base_commit: str, workspace_path: Path = WORKSPACE) -> None:
    reset = _run(
        ["git", "reset", "--hard", base_commit],
        cwd=workspace_path,
        as_workspace_owner=True,
    )
    clean = _run(
        ["git", "clean", "-fdx"],
        cwd=workspace_path,
        as_workspace_owner=True,
    )
    if reset.returncode or clean.returncode:
        raise RuntimeError(f"workspace reset failed: {reset.stderr}{clean.stderr}")


def collect_patch(base_commit: str, workspace_path: Path = WORKSPACE) -> str:
    with tempfile.TemporaryDirectory(prefix="parallax-index-") as directory:
        if os.geteuid() == 0:
            os.chown(directory, WORKSPACE_UID, WORKSPACE_UID)
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
            as_workspace_owner=True,
        )
        if read_tree.returncode:
            raise RuntimeError(f"temporary index failed: {read_tree.stderr}")
        add = _run(
            ["git", "add", "-A"],
            cwd=workspace_path,
            env=environment,
            as_workspace_owner=True,
        )
        if add.returncode:
            raise RuntimeError(f"candidate patch staging failed: {add.stderr}")
        diff = _run(
            ["git", "diff", "--cached", "--binary", "--full-index", base_commit],
            cwd=workspace_path,
            env=environment,
            as_workspace_owner=True,
        )
        if diff.returncode:
            raise RuntimeError(f"candidate patch export failed: {diff.stderr}")
        return diff.stdout


def isolation_probe_argv() -> list[str]:
    if not workspace.bwrap_available:
        raise RuntimeError("bubblewrap is required for agent filesystem isolation")
    return workspace.shell_argv("test ! -e /app/instance.json")


def require_complete_delivery(
    answer: Answer[CompleteDeliveryReceiptV1],
    *,
    turns: list[str],
    step_budgets: list[int],
) -> CompleteDeliveryReceiptV1:
    receipt = answer.content
    if not isinstance(receipt, CompleteDeliveryReceiptV1):
        raise RuntimeError("episode answer is not a complete delivery receipt")
    if receipt.turn_count != len(turns):
        raise RuntimeError("delivery receipt turn count differs from script")
    if tuple(phase.step_budget for phase in receipt.phases) != tuple(step_budgets):
        raise RuntimeError("delivery receipt phase budgets differ from script")
    return receipt


@env.initialize
async def _verify_isolation() -> None:
    result = await asyncio.to_thread(_run, isolation_probe_argv(), cwd=WORKSPACE)
    if result.returncode:
        raise RuntimeError(
            f"agent filesystem isolation probe failed: {result.stderr.strip()}"
        )


@env.template(id="episode", returns=CompleteDeliveryReceiptV1)
async def episode(arm: str):
    scripts = CONFIG["scripts"]
    if arm not in scripts:
        raise ValueError(f"unknown arm: {arm}")
    source = CONFIG["source"]
    await asyncio.to_thread(reset_workspace, source["base_commit"])
    script = scripts[arm]
    answer = yield script["turns"][0]
    receipt = require_complete_delivery(
        answer,
        turns=script["turns"],
        step_budgets=script["agent_steps"],
    )
    patch = await asyncio.to_thread(collect_patch, source["base_commit"])
    yield EvaluationResult(
        reward=0.0,
        content="candidate patch exported for evaluator-side official grading",
        info={
            "arm": arm,
            "delivery": receipt.model_dump(mode="json"),
            "final_turn": receipt.turn_count - 1,
            "model_patch": patch,
            "schedule_complete": True,
            "steps_consumed": sum(phase.steps_consumed for phase in receipt.phases),
            "total_agent_steps": receipt.total_step_budget,
            "turns": receipt.turn_count,
        },
    )
