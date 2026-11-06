from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from hud.environment import Answer
from test_swebench import INSTANCE_ID, construction, row, runtime

from parallax.delivery import CompleteDeliveryReceiptV1, PhaseActivityV1
from parallax.hud_compile import compile_hud
from parallax.hud_screening import _docker_runtime
from parallax.specs import freeze_swe_specs
from parallax.swebench import build_swe_script_family, load_swebench_rows
from parallax.swebench_runtime import (
    collect_patch,
    isolation_probe_argv,
    require_complete_delivery,
    workspace,
    workspace_owner_argv,
)


def family():
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    return build_swe_script_family(
        problem,
        construction(),
        total_agent_steps=12,
        max_output_tokens=4096,
    )


def bundle():
    task, environment = freeze_swe_specs(family())
    return compile_hud(task, environment)


def test_environment_bundle_is_public_deterministic_and_importable() -> None:
    first = bundle()
    second = bundle()

    assert first == second
    artifacts = {artifact.path: artifact.content for artifact in first.agent_artifacts}
    compile(artifacts["env.py"], "env.py", "exec")
    compile(
        artifacts["parallax/swebench_runtime.py"],
        "parallax/swebench_runtime.py",
        "exec",
    )
    config = json.loads(artifacts["instance.json"])
    assert "verifier" not in config
    assert "sealed test patch" not in artifacts["instance.json"].decode()
    assert artifacts["env.py"] == b"from parallax.swebench_runtime import env\n"
    assert b"class CompleteDeliveryReceiptV1" in artifacts["parallax/delivery.py"]


def dockerfile_of(compiled) -> str:
    return next(
        artifact.content
        for artifact in compiled.agent_artifacts
        if artifact.path == "Dockerfile.hud"
    ).decode()


def test_dockerfile_base_image_tracks_the_environment_spec() -> None:
    task, environment = freeze_swe_specs(family())
    other = environment.model_copy(
        update={"image": environment.image.model_copy(update={"digest": "b" * 64})}
    )

    first = dockerfile_of(compile_hud(task, environment))
    second = dockerfile_of(compile_hud(task, other))

    assert first.splitlines()[0].endswith(
        f"{environment.image.ref}@sha256:{environment.image.digest}"
    )
    assert second.splitlines()[0].endswith(
        f"{other.image.ref}@sha256:{other.image.digest}"
    )
    assert first != second


def test_dockerfile_build_reaches_no_network_source_repository() -> None:
    dockerfile = dockerfile_of(bundle())

    assert "git clone" not in dockerfile
    assert "git fetch" not in dockerfile


def test_local_docker_runtime_allows_inner_bubblewrap() -> None:
    runtime = _docker_runtime("screening-image")

    assert runtime.run_args == ("--privileged",)
    assert runtime.runtime_config.image == "screening-image"


def test_environment_git_commands_drop_to_workspace_owner() -> None:
    command = workspace_owner_argv(["git", "status"], effective_uid=0)

    assert command[:7] == [
        "/usr/bin/setpriv",
        "--reuid",
        "1000",
        "--regid",
        "1000",
        "--clear-groups",
        "--",
    ]
    assert command[7:] == ["git", "status"]


def test_compiled_environment_has_no_agent_turn_control_tool() -> None:
    compiled = bundle()
    task, environment = freeze_swe_specs(family())
    runtime_source = next(
        artifact.content
        for artifact in compiled.agent_artifacts
        if artifact.path == "parallax/swebench_runtime.py"
    )

    assert tuple(tool.name for tool in environment.tools) == ("shell",)
    assert b"def advance(" not in runtime_source
    assert b"FastMCP" not in runtime_source
    assert task.public.scripts[2].agent_steps == task.public.scripts[1].agent_steps


def test_environment_rejects_receipt_for_incomplete_script() -> None:
    receipt = CompleteDeliveryReceiptV1(
        turn_count=1,
        total_step_budget=3,
        phases=(
            PhaseActivityV1(
                turn_index=0,
                step_budget=3,
                steps_consumed=1,
                advance_trigger="terminal_submission",
            ),
        ),
    )

    with pytest.raises(RuntimeError, match="turn count differs"):
        require_complete_delivery(
            Answer(content=receipt, raw=receipt.as_answer()),
            turns=["first", "second"],
            step_budgets=[3, 3],
        )


def test_all_arms_receive_one_equal_episode_budget() -> None:
    compiled = bundle()
    instance = next(
        artifact.content
        for artifact in compiled.agent_artifacts
        if artifact.path == "instance.json"
    )
    config = json.loads(instance)
    scripts = config["scripts"]

    assert sum(scripts["static"]["agent_steps"]) == 12
    assert sum(scripts["matched"]["agent_steps"]) == 12
    assert sum(scripts["evolved"]["agent_steps"]) == 12
    assert scripts["static"]["agent_steps"] == [12]
    runtime_source = next(
        artifact.content
        for artifact in compiled.agent_artifacts
        if artifact.path == "parallax/swebench_runtime.py"
    )
    assert b"require_complete_delivery" in runtime_source


def test_bundle_writes_only_expected_files(tmp_path: Path) -> None:
    compiled = bundle()
    compiled.write_agent_context(tmp_path)

    assert {
        path.relative_to(tmp_path).as_posix()
        for path in tmp_path.rglob("*")
        if path.is_file()
    } == {
        "Dockerfile.hud",
        "env.py",
        "instance.json",
        "parallax/__init__.py",
        "parallax/delivery.py",
        "parallax/swebench_runtime.py",
    }
    expected = next(
        artifact.content
        for artifact in compiled.agent_artifacts
        if artifact.path == "instance.json"
    )
    assert (tmp_path / "instance.json").read_bytes() == expected


def test_patch_export_includes_modified_and_untracked_files(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"],
        cwd=tmp_path,
        check=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=tmp_path,
        check=True,
    )
    (tmp_path / "existing.py").write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-qm", "base"], cwd=tmp_path, check=True)
    base = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    (tmp_path / "existing.py").write_text("after\n", encoding="utf-8")
    (tmp_path / "new.py").write_text("new\n", encoding="utf-8")

    patch = collect_patch(base, tmp_path)

    assert "existing.py" in patch
    assert "new.py" in patch
    assert "new file mode" in patch


def test_workspace_namespace_does_not_mount_app(monkeypatch) -> None:
    monkeypatch.setattr(workspace, "_bwrap", "/usr/bin/bwrap")
    monkeypatch.setattr(workspace, "_drops_privileges", lambda: False)

    argv = isolation_probe_argv()

    mounts = tuple(
        argv[index + 2]
        for index, value in enumerate(argv)
        if value in {"--bind", "--ro-bind"}
    )
    assert "/app" not in mounts
    assert "/testbed" in mounts
