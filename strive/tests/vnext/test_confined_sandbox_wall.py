"""Exercise jail supervision on any host; native confinement stays Linux-only."""
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time
from typing import BinaryIO

import pytest

from strive.vnext.contracts.commands import Finish
from strive.vnext.runtime import confined_sandbox
from strive.vnext.runtime.confined_sandbox import DenoSandbox
from strive.vnext.runtime.linux_jail import Capability, JailUnavailable, LinuxJail
from strive.vnext.runtime.sandbox import SandboxFailure, SandboxLimits

from .test_linux_jail import require_jail
from .test_runtime_sandbox import RETURN_FINISH, view


class DelayedLauncher(LinuxJail):
    """Real process/session, no kernel jail. Models a launcher before attachment."""

    def __init__(self, tmp_path: Path) -> None:
        self.group = tmp_path / "not-yet-attached"
        self._created = False
        self.process = None
        self.events = {}
        self.startup = "import os, sys, time; time.sleep(0.4); os.execv(sys.argv[1], sys.argv[1:])"
        self.child: subprocess.Popen[bytes] | None = None

    def launch(self, command: list[str], *, stdin: int | BinaryIO = subprocess.PIPE) -> subprocess.Popen[bytes]:
        self.process = subprocess.Popen([sys.executable, "-I", "-c", self.startup, *command],
            stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            close_fds=True, start_new_session=True)
        self.child = self.process
        return self.process


@pytest.fixture
def supervised(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[DenoSandbox, DelayedLauncher]:
    if shutil.which("deno") is None:
        pytest.skip("Deno required for bootstrap readiness tests")
    jail = DelayedLauncher(tmp_path)
    monkeypatch.setattr(confined_sandbox, "capability", lambda: Capability(True, "test launcher", b"test"))
    monkeypatch.setattr(LinuxJail, "available", lambda **kwargs: jail)
    return DenoSandbox(tmp_path / "scratch", SandboxLimits(wall_seconds=0.2)), jail


@pytest.mark.parametrize("source, message", [
    (("function step(){" + RETURN_FINISH + "}").encode(), None),
    (b"async function step(){await new Promise(r=>setTimeout(r,10000));}", "candidate wall limit exceeded"),
    (b"while(true){}; function step(){}", "candidate wall limit exceeded"),
    (b"function step(){Deno.stdout.close(); Deno.stderr.close(); while(true){}}", "candidate wall limit exceeded"),
])
def test_slow_startup_preserves_candidate_wall_budget(supervised: tuple[DenoSandbox, DelayedLauncher],
                                                     source: bytes, message: str | None) -> None:
    sandbox, jail = supervised
    before = time.monotonic()
    if message is None:
        assert isinstance(sandbox.run(source, view(), b"", None, {}).command, Finish)
    else:
        with pytest.raises(SandboxFailure, match=message):
            sandbox.run(source, view(), b"", None, {})
    elapsed = time.monotonic() - before
    assert 0.4 <= elapsed < 5, "startup is excluded, but the 10-second candidate must be killed"
    assert jail.child is not None and jail.child.poll() is not None
    assert list(sandbox.scratch_root.iterdir()) == []


def test_startup_hang_kills_launcher_before_cgroup_attachment(supervised: tuple[DenoSandbox, DelayedLauncher],
                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    sandbox, jail = supervised
    jail.startup = "import time; time.sleep(10)"
    monkeypatch.setattr(confined_sandbox, "_STARTUP_SECONDS", 0.2)
    before = time.monotonic()
    with pytest.raises(SandboxFailure, match="candidate jail startup limit exceeded"):
        sandbox.run(b"function step(){}", view(), b"", None, {})
    assert time.monotonic() - before < 5
    assert jail.child is not None and jail.child.returncode == -signal.SIGKILL
    assert list(sandbox.scratch_root.iterdir()) == []


@pytest.mark.parametrize("prefix, message", [
    (b"", "missing ready signal"),
    (b"strive-candidate", "missing ready signal"),
    (b"untrusted output", "invalid ready signal"),
])
def test_startup_requires_complete_ready_signal(supervised: tuple[DenoSandbox, DelayedLauncher],
                                              prefix: bytes, message: str) -> None:
    sandbox, jail = supervised
    jail.startup = f"import os; os.write(1, {prefix!r})"
    with pytest.raises(SandboxFailure, match=message):
        sandbox.run(b"function step(){}", view(), b"", None, {})


@pytest.mark.parametrize("fragmented", [False, True])
def test_ready_signal_is_removed_once_and_excluded_from_output_cap(supervised: tuple[DenoSandbox, DelayedLauncher],
                                                                 fragmented: bool) -> None:
    sandbox, jail = supervised
    ready = confined_sandbox._READY
    # The second prefix is candidate output; it must survive byte-for-byte.
    output = ready + b"done"
    sandbox.limits = SandboxLimits(wall_seconds=0.2, output_bytes=len(output))
    if fragmented:
        jail.startup = (f"import os, time; os.write(1, {ready[:5]!r}); time.sleep(0.3); "
                        f"os.write(1, {ready[5:] + output!r})")
    else:
        jail.startup = f"import os; os.write(1, {ready + output!r})"
    scratch = sandbox.scratch_root
    (scratch / "bootstrap.js").write_text("")
    assert sandbox._capture([], b"", scratch) == output


def test_candidate_ready_output_cannot_extend_deadline(supervised: tuple[DenoSandbox, DelayedLauncher]) -> None:
    sandbox, _ = supervised
    source = b'async function step(){for(let i=0;i<20;i++){console.log("strive-candidate-ready/1");await new Promise(r=>setTimeout(r,50));}}'
    before = time.monotonic()
    with pytest.raises(SandboxFailure, match="candidate wall limit exceeded"):
        sandbox.run(source, view(), b"", None, {})
    assert time.monotonic() - before < 5


def test_candidate_output_cap_still_applies(supervised: tuple[DenoSandbox, DelayedLauncher]) -> None:
    sandbox, _ = supervised
    sandbox.limits = SandboxLimits(output_bytes=4096)
    with pytest.raises(SandboxFailure, match="candidate output limit exceeded"):
        sandbox.run(b'function step(){while(true)console.log("x".repeat(8192));}', view(), b"", None, {})


def test_cleanup_timeout_is_a_distinct_jail_error(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    jail = DelayedLauncher(tmp_path)
    child = jail.launch([])
    real_wait = child.wait

    def stuck_wait(timeout: float | None = None) -> int:
        assert timeout is not None
        raise subprocess.TimeoutExpired(child.args, timeout)

    monkeypatch.setattr(child, "wait", stuck_wait)
    try:
        with pytest.raises(JailUnavailable, match="jail launcher did not exit after tree termination"):
            jail.close()
    finally:
        real_wait(timeout=5)
        assert child.stdout is not None and child.stderr is not None
        child.stdout.close()
        child.stderr.close()


def test_reaped_launcher_still_kills_cgroup_without_signaling_old_pid(tmp_path: Path,
                                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    jail = DelayedLauncher(tmp_path)
    jail.startup = "pass"
    child = jail.launch([])
    child.communicate(timeout=5)
    jail.group.mkdir()
    jail._created = True

    def unexpected_signal(pid: int, sig: int) -> None:
        pytest.fail("a reaped launcher's PID may have been reused")

    monkeypatch.setattr("strive.vnext.runtime.linux_jail.os.killpg", unexpected_signal)
    jail.kill()
    assert (jail.group / "cgroup.kill").read_text() == "1"
    jail._created = False  # This test directory is not a kernel cgroup.
    jail.close()


@pytest.mark.parametrize("slow_candidate", [False, True])
def test_native_jail_wall_budget_after_slow_startup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                  slow_candidate: bool) -> None:
    require_jail()
    delay = tmp_path / "delay.py"
    delay.write_text("import os, sys, time\ntime.sleep(0.4)\nos.execv(sys.argv[1], sys.argv[1:])\n")
    original_launch = LinuxJail.launch
    groups: list[Path] = []

    def launch(self: LinuxJail, command: list[str], *, stdin: int | BinaryIO = subprocess.PIPE) -> subprocess.Popen[bytes]:
        groups.append(self.group)
        return original_launch(self, [sys.executable, "-I", str(delay), *command], stdin=stdin)

    monkeypatch.setattr(LinuxJail, "launch", launch)
    sandbox = DenoSandbox(tmp_path / "scratch", SandboxLimits(wall_seconds=0.2))
    if slow_candidate:
        with pytest.raises(SandboxFailure, match="candidate wall limit exceeded"):
            sandbox.run(b"async function step(){await new Promise(r=>setTimeout(r,10000));}", view(), b"", None, {})
    else:
        assert isinstance(sandbox.run(("function step(){" + RETURN_FINISH + "}").encode(), view(), b"", None, {}).command, Finish)
    assert groups and all(not group.exists() for group in groups)
    assert list(sandbox.scratch_root.iterdir()) == []
