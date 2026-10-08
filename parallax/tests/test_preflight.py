from __future__ import annotations

import os
import subprocess
import sys
import time

import pytest

from parallax import preflight
from parallax.preflight import (
    DOCKER_PLATFORM,
    PreflightError,
    require_docker,
    sleepless,
    terminate_group,
)


def test_docker_preflight_pins_the_amd64_platform(monkeypatch) -> None:
    monkeypatch.delenv("DOCKER_DEFAULT_PLATFORM", raising=False)
    monkeypatch.setattr(preflight.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        preflight.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, "28.0.0", ""),
    )

    require_docker(minimum_free_bytes=0)

    assert os.environ["DOCKER_DEFAULT_PLATFORM"] == DOCKER_PLATFORM


def test_docker_preflight_refuses_a_conflicting_platform(monkeypatch) -> None:
    monkeypatch.setenv("DOCKER_DEFAULT_PLATFORM", "linux/arm64")

    with pytest.raises(PreflightError, match="linux/amd64"):
        require_docker()


def test_docker_preflight_refuses_an_unreachable_daemon(monkeypatch) -> None:
    monkeypatch.setenv("DOCKER_DEFAULT_PLATFORM", DOCKER_PLATFORM)
    monkeypatch.setattr(preflight.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        preflight.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args, 1, "", "Cannot connect to the Docker daemon"
        ),
    )

    with pytest.raises(PreflightError, match="not reachable"):
        require_docker(minimum_free_bytes=0)


def test_docker_preflight_refuses_to_start_without_disk_headroom(monkeypatch) -> None:
    monkeypatch.setenv("DOCKER_DEFAULT_PLATFORM", DOCKER_PLATFORM)
    monkeypatch.setattr(preflight.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(
        preflight.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args, 0, "28.0.0", ""),
    )

    with pytest.raises(PreflightError, match="prune_docker_disk"):
        require_docker(minimum_free_bytes=2**62)


def test_terminate_group_kills_the_whole_group_not_just_the_wrapper() -> None:
    wrapper = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import subprocess, sys, time;"
                "child = subprocess.Popen([sys.executable, '-c',"
                " 'import time; time.sleep(120)']);"
                "print(child.pid, flush=True);"
                "time.sleep(120)"
            ),
        ],
        start_new_session=True,
        stdout=subprocess.PIPE,
        text=True,
    )
    assert wrapper.stdout is not None
    grandchild = int(wrapper.stdout.readline().strip())

    terminate_group(wrapper)

    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        try:
            os.kill(grandchild, 0)
        except ProcessLookupError:
            break
        time.sleep(0.05)
    else:
        os.kill(grandchild, 9)
        pytest.fail("orphan survived a process-group termination")

    assert wrapper.poll() is not None


def test_terminate_group_is_safe_on_an_exited_process() -> None:
    process = subprocess.Popen([sys.executable, "-c", ""], start_new_session=True)
    process.wait()

    terminate_group(process)


def test_sleepless_is_a_no_op_that_still_yields_off_macos(monkeypatch) -> None:
    monkeypatch.setattr(preflight.shutil, "which", lambda name: None)
    entered = False

    with sleepless():
        entered = True

    assert entered
