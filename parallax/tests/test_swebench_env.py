from __future__ import annotations

import json
import subprocess
from pathlib import Path

from test_swebench import INSTANCE_ID, construction, row, runtime

from parallax import swebench_runtime
from parallax.hud_compile import compile_hud
from parallax.hud_screening import _docker_runtime
from parallax.specs import freeze_swe_specs
from parallax.swebench import build_swe_script_family, load_swebench_rows
from parallax.swebench_runtime import (
    advance,
    collect_patch,
    isolation_probe_argv,
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
    compile(artifacts["swebench_runtime.py"], "swebench_runtime.py", "exec")
    config = json.loads(artifacts["instance.json"])
    assert "verifier" not in config
    assert "sealed test patch" not in artifacts["instance.json"].decode()
    assert artifacts["env.py"] == b"from swebench_runtime import env\n"


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


def test_director_advances_one_turn_at_a_time_then_reports_done() -> None:
    token = "episode-token"
    swebench_runtime._states[token] = {
        "agent_steps": [4, 8],
        "index": 0,
        "turns": ["first turn", "second turn"],
    }
    try:
        assert advance(token) == {
            "done": False,
            "index": 1,
            "step_budget": 8,
            "turn": "second turn",
        }
        assert advance(token) == {"done": True, "index": 1}
    finally:
        swebench_runtime._states.pop(token)


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
        if artifact.path == "swebench_runtime.py"
    )
    assert b"step_budget" in runtime_source


def test_bundle_writes_only_expected_files(tmp_path: Path) -> None:
    compiled = bundle()
    compiled.write_agent_context(tmp_path)

    assert {path.name for path in tmp_path.iterdir()} == {
        "Dockerfile.hud",
        "env.py",
        "instance.json",
        "swebench_runtime.py",
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
