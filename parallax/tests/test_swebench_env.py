from __future__ import annotations

import json
from pathlib import Path

from test_swebench import INSTANCE_ID, construction, row, runtime

from parallax.swebench import build_swe_script_family, load_swebench_rows
from parallax.swebench_env import render_environment


def family():
    problem = load_swebench_rows(
        (row(),),
        (INSTANCE_ID,),
        runtimes={INSTANCE_ID: runtime()},
    )[0]
    return build_swe_script_family(
        problem,
        construction(),
        seed=7,
        total_agent_steps=12,
        max_output_tokens=4096,
    )


def test_environment_bundle_is_deterministic_and_compilable() -> None:
    first = render_environment(family())
    second = render_environment(family())

    assert first == second
    compile(first.env_py, "env.py", "exec")
    assert b"ALLOWED_PATHS" not in first.env_py
    config = json.loads(first.instance_json)
    assert config["verifier"]["test_patch"] == "sealed test patch"
    assert all(
        "sealed test patch" not in turn
        for script in config["scripts"].values()
        for turn in script["turns"]
    )


def test_dockerfile_uses_official_pinned_eval_image() -> None:
    dockerfile = render_environment(family()).dockerfile.decode()

    assert (
        "swebench/sweb.eval.x86_64.astropy_1776_astropy-13236@sha256:" + "a" * 64
    ) in dockerfile
    assert "hud==0.6.12" in dockerfile
    assert "git clone" not in dockerfile
    assert "git fetch" not in dockerfile


def test_all_arms_receive_one_equal_episode_budget() -> None:
    config = json.loads(render_environment(family()).instance_json)
    scripts = config["scripts"]

    assert sum(scripts["static"]["agent_steps"]) == 12
    assert sum(scripts["matched"]["agent_steps"]) == 12
    assert sum(scripts["evolved"]["agent_steps"]) == 12
    assert scripts["static"]["agent_steps"] == [12]
    assert "step_budget" in render_environment(family()).env_py.decode()


def test_bundle_writes_only_expected_files(tmp_path: Path) -> None:
    bundle = render_environment(family())
    bundle.write(tmp_path)

    assert {path.name for path in tmp_path.iterdir()} == {
        "Dockerfile.hud",
        "env.py",
        "instance.json",
    }
    assert (tmp_path / "instance.json").read_bytes() == bundle.instance_json
