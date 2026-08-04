from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from parallax.checkpoint_evolution import (
    SealedCase,
    VerifierError,
    Workspace,
    run_case_trusted,
    verify_stage,
)
from parallax.checkpoint_sandbox import (
    PINNED_SANDBOX,
    SandboxCaseExecution,
    SandboxSpec,
)

LOCKDOWN_FLAGS = (
    "--rm",
    "--pull=never",
    "--platform=linux/amd64",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=1000:1000",
    "--cpus=1.0",
    "--memory=512m",
    "--memory-swap=512m",
    "--pids-limit=128",
    "--workdir=/work",
    "--env=PYTHONHASHSEED=0",
    "--env=PYTHONIOENCODING=utf-8",
)


class SimulatedDockerRunner:
    """TRUSTED-FIXTURE simulation of the container runner.

    Records every docker argv for shape assertions, then executes the
    materialized working directory with the host interpreter. Only fixture
    reference code ever runs through this; it exists so the sandbox wiring
    is testable without a Docker daemon.
    """

    def __init__(self) -> None:
        self.commands: list[list[str]] = []

    def __call__(
        self, argv: list[str], stdin_text: str, timeout_seconds: float
    ) -> subprocess.CompletedProcess[str]:
        self.commands.append(list(argv))
        assert argv[0] == "docker"
        volume = next(part for part in argv if part.startswith("--volume="))
        root = Path(volume.removeprefix("--volume=").removesuffix(":/work"))
        python_at = argv.index("python3")
        return subprocess.run(
            [sys.executable, *argv[python_at + 1 :]],
            cwd=root,
            input=stdin_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=timeout_seconds,
            check=False,
        )


def _scripted_runner(
    returncode: int, stdout: str = "", stderr: str = ""
) -> tuple[SandboxCaseExecution, list[list[str]]]:
    commands: list[list[str]] = []

    def runner(argv, stdin_text, timeout_seconds):
        commands.append(list(argv))
        return subprocess.CompletedProcess(
            argv, returncode, stdout=stdout, stderr=stderr
        )

    return SandboxCaseExecution(runner=runner), commands


def _first_case(seed_fixture):
    checkpoint = seed_fixture.family.checkpoints[0]
    return seed_fixture.family.contract, checkpoint.cases[0]


def test_sandbox_command_is_fully_locked_down(seed_fixture) -> None:
    contract, case = _first_case(seed_fixture)
    command = SandboxCaseExecution().command(Path("/scratch"), contract, case)
    for flag in LOCKDOWN_FLAGS:
        assert flag in command, flag
    assert "--volume=/scratch:/work" in command
    assert any(part.startswith("--tmpfs=/tmp:rw,size=16m") for part in command)
    image_at = command.index(PINNED_SANDBOX.image)
    assert PINNED_SANDBOX.image == (
        "python@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de"
    )
    assert command[image_at + 1 :] == [
        "timeout",
        str(contract.timeout_seconds),
        "python3",
        contract.entry_file,
        *case.argv,
    ]


def test_sandbox_matches_trusted_verdicts_on_the_gold_workspace(
    seed_fixture,
) -> None:
    runner = SimulatedDockerRunner()
    execute = SandboxCaseExecution(runner=runner)
    index = len(seed_fixture.family.checkpoints)
    gold = seed_fixture.references.stages[-1]
    sandboxed = verify_stage(seed_fixture.family, index, gold, execute=execute)
    trusted = verify_stage(seed_fixture.family, index, gold, execute=run_case_trusted)
    assert sandboxed == trusted
    assert sandboxed.strict_pass
    assert len(runner.commands) == len(seed_fixture.family.obligations(index))
    for command in runner.commands:
        for flag in LOCKDOWN_FLAGS:
            assert flag in command


def test_in_container_deadline_is_a_case_timeout(seed_fixture) -> None:
    contract, case = _first_case(seed_fixture)
    execute, _ = _scripted_runner(124)
    assert execute(contract, Workspace(files=()), case) == "timeout"


def test_docker_fault_exit_codes_are_verifier_failures(seed_fixture) -> None:
    contract, case = _first_case(seed_fixture)
    execute, _ = _scripted_runner(
        125, stderr="docker: Error response from daemon: image not found."
    )
    with pytest.raises(VerifierError, match="sandbox fault"):
        execute(contract, Workspace(files=()), case)


def test_program_exit_codes_are_preserved_without_docker_noise(
    seed_fixture,
) -> None:
    contract, case = _first_case(seed_fixture)
    execute, _ = _scripted_runner(125, stderr="a program wrote this")
    assert execute(contract, Workspace(files=()), case) == "exit-code-mismatch"


def test_spawn_faults_are_verifier_failures(seed_fixture) -> None:
    contract, case = _first_case(seed_fixture)

    def missing_docker(argv, stdin_text, timeout_seconds):
        raise FileNotFoundError("docker binary is absent")

    def stalled_container(argv, stdin_text, timeout_seconds):
        raise subprocess.TimeoutExpired(argv, timeout_seconds)

    for runner in (missing_docker, stalled_container):
        execute = SandboxCaseExecution(runner=runner)
        with pytest.raises(VerifierError):
            execute(contract, Workspace(files=()), case)


def test_sandbox_spec_is_pinned_by_digest() -> None:
    assert SandboxSpec() == PINNED_SANDBOX
    assert PINNED_SANDBOX.platform == "linux/amd64"
    assert PINNED_SANDBOX.user == "1000:1000"


def _docker_ready() -> bool:
    if shutil.which("docker") is None:
        return False
    probe = subprocess.run(
        ["docker", "image", "inspect", PINNED_SANDBOX.image],
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    return probe.returncode == 0


docker_required = pytest.mark.skipif(
    not _docker_ready(),
    reason="Docker daemon with the pinned sandbox image is unavailable",
)


@docker_required
def test_real_container_runs_the_gold_stage(seed_fixture) -> None:
    execute = SandboxCaseExecution()
    checkpoint = seed_fixture.family.checkpoints[0]
    gold = seed_fixture.references.stages[0]
    for case in checkpoint.cases:
        assert execute(seed_fixture.family.contract, gold, case) == "pass"


@docker_required
def test_real_container_probe_proves_containment(seed_fixture) -> None:
    contract, _ = _first_case(seed_fixture)
    probe = Workspace.from_files(
        {
            contract.entry_file: (
                "import socket\n"
                "try:\n"
                '    socket.create_connection(("1.1.1.1", 80), timeout=2)\n'
                '    print("network-open")\n'
                "except OSError:\n"
                '    print("network-denied")\n'
                "try:\n"
                '    open("/etc/parallax-escape", "w").write("x")\n'
                '    print("rootfs-writable")\n'
                "except OSError:\n"
                '    print("rootfs-denied")\n'
            )
        }
    )
    case = SealedCase(
        case_id="containment-probe",
        category="core",
        argv=(),
        stdin_text="",
        input_files=(),
        expected_stdout="network-denied\nrootfs-denied\n",
        expected_exit_code=0,
        expect_stderr=False,
    )
    assert SandboxCaseExecution()(contract, probe, case) == "pass"
