"""Operational preconditions for paid runs, applied by construction.

These used to be prose in NOTES: set the platform, check the daemon, keep the
machine awake, kill the process group and not the wrapper, prune when the disk
fills. Each one was rediscovered by losing a run to it, so each one is code
that a driver cannot forget to call: `HudExecutor` runs `require_docker()`
before it can build an image, and `sleepless()`/`terminate_group()` are the
only supported ways to hold a long run open and to stop one.
"""

from __future__ import annotations

import contextlib
import os
import shutil
import signal
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

DOCKER_PLATFORM = "linux/amd64"
DISK_HEADROOM_BYTES = 20 * 1024**3


class PreflightError(RuntimeError):
    pass


def require_docker(*, minimum_free_bytes: int = DISK_HEADROOM_BYTES) -> None:
    """Pin the image platform, prove the daemon answers, and check headroom.

    The official SWE-bench images are `linux/amd64` only, so an Apple Silicon
    host silently builds an unusable arm64 image unless the platform is pinned
    in the environment as well as on the build command.
    """
    os.environ.setdefault("DOCKER_DEFAULT_PLATFORM", DOCKER_PLATFORM)
    if os.environ["DOCKER_DEFAULT_PLATFORM"] != DOCKER_PLATFORM:
        raise PreflightError(
            "DOCKER_DEFAULT_PLATFORM must be "
            f"{DOCKER_PLATFORM}, found "
            f"{os.environ['DOCKER_DEFAULT_PLATFORM']}"
        )
    if shutil.which("docker") is None:
        raise PreflightError("docker is not on PATH")
    probe = subprocess.run(
        ["docker", "info", "--format", "{{.ServerVersion}}"],
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    if probe.returncode:
        raise PreflightError(f"docker daemon is not reachable: {probe.stderr.strip()}")
    free = shutil.disk_usage(Path.home()).free
    if free < minimum_free_bytes:
        raise PreflightError(
            f"{free // 1024**3} GiB free is below the "
            f"{minimum_free_bytes // 1024**3} GiB an image build needs; "
            "run prune_docker_disk() and retry"
        )


def prune_docker_disk() -> str:
    """Reclaim image and build-cache space after a build filled the disk."""
    result = subprocess.run(
        ["docker", "system", "prune", "--force", "--all"],
        text=True,
        capture_output=True,
        timeout=1800,
        check=False,
    )
    if result.returncode:
        raise PreflightError(f"docker prune failed: {result.stderr.strip()}")
    return result.stdout


@contextlib.contextmanager
def sleepless() -> Iterator[None]:
    """Hold macOS awake for the duration of a long run.

    A run that outlives the idle-sleep timer loses its containers and its paid
    episodes. On other platforms this is a no-op.
    """
    if sys.platform != "darwin" or shutil.which("caffeinate") is None:
        yield
        return
    process = subprocess.Popen(
        ["caffeinate", "-dimsu", "-w", str(os.getpid())],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        yield
    finally:
        terminate_group(process)


def terminate_group(
    process: subprocess.Popen[Any],
    *,
    timeout: float = 10.0,
) -> None:
    """Signal the child's whole process group, not just the wrapper.

    Wrappers fork; signalling the immediate child leaves an orphan running,
    which once kept paying for episodes after its launcher was killed.
    """
    if process.poll() is not None:
        return
    try:
        group = os.getpgid(process.pid)
    except ProcessLookupError:
        return
    for sig in (signal.SIGTERM, signal.SIGKILL):
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(group, sig)
        try:
            process.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            continue
