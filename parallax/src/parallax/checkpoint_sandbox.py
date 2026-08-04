from __future__ import annotations

import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Literal, TypeAlias

from pydantic import Field

from .checkpoint_evolution import (
    CaseDetail,
    EntrypointContract,
    SealedCase,
    VerifierError,
    Workspace,
    materialize_case,
)
from .types import DigestText, NonEmptyText, StrictModel

# GNU coreutils `timeout` exit status when the deadline fires inside the
# container; docker CLI statuses for daemon/spawn-level faults.
CASE_TIMEOUT_EXIT_CODE = 124
DOCKER_FAULT_EXIT_CODES = frozenset({125, 126, 127})

SANDBOX_IMAGE_REF = "python"
SANDBOX_IMAGE_DIGEST = (
    "57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de"
)

SandboxRunner: TypeAlias = Callable[
    [list[str], str, float],
    subprocess.CompletedProcess[str],
]


def _run_docker(
    argv: list[str],
    stdin_text: str,
    timeout_seconds: float,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        input=stdin_text,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout_seconds,
        check=False,
    )


class SandboxSpec(StrictModel):
    image_ref: NonEmptyText = SANDBOX_IMAGE_REF
    image_digest: DigestText = SANDBOX_IMAGE_DIGEST
    platform: Literal["linux/amd64"] = "linux/amd64"
    user: Literal["1000:1000"] = "1000:1000"
    cpu_limit: Annotated[float, Field(gt=0, le=8, allow_inf_nan=False)] = 1.0
    memory_megabytes: Annotated[int, Field(gt=0, le=4096)] = 512
    process_limit: Annotated[int, Field(gt=0, le=1024)] = 128
    tmpfs_megabytes: Annotated[int, Field(gt=0, le=256)] = 16
    startup_allowance_seconds: Annotated[
        float, Field(gt=0, le=600, allow_inf_nan=False)
    ] = 60.0

    @property
    def image(self) -> str:
        return f"{self.image_ref}@sha256:{self.image_digest}"


PINNED_SANDBOX = SandboxSpec()


class SandboxCaseExecution:
    """Container execution for model-written code.

    Every sealed case runs in a disposable container from a digest-pinned
    image with no network, a read-only root filesystem, a non-root user, and
    CPU/memory/process limits. Only the materialized working directory is
    writable. The case timeout is enforced inside the container by
    `timeout`; the outer subprocess deadline only bounds container spawn and
    teardown, so an outer expiry is an infrastructure fault, not a verdict.
    """

    def __init__(
        self,
        spec: SandboxSpec = PINNED_SANDBOX,
        *,
        runner: SandboxRunner = _run_docker,
    ) -> None:
        self.spec = spec
        self._runner = runner

    def command(
        self,
        root: Path,
        contract: EntrypointContract,
        case: SealedCase,
    ) -> list[str]:
        spec = self.spec
        return [
            "docker",
            "run",
            "--rm",
            "--interactive",
            "--pull=never",
            f"--platform={spec.platform}",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            f"--user={spec.user}",
            f"--cpus={spec.cpu_limit}",
            f"--memory={spec.memory_megabytes}m",
            f"--memory-swap={spec.memory_megabytes}m",
            f"--pids-limit={spec.process_limit}",
            f"--tmpfs=/tmp:rw,size={spec.tmpfs_megabytes}m,mode=1777",
            f"--volume={root}:/work",
            "--workdir=/work",
            "--env=PYTHONHASHSEED=0",
            "--env=PYTHONIOENCODING=utf-8",
            spec.image,
            "timeout",
            f"{contract.timeout_seconds}",
            "python3",
            contract.entry_file,
            *case.argv,
        ]

    def __call__(
        self,
        contract: EntrypointContract,
        workspace: Workspace,
        case: SealedCase,
    ) -> CaseDetail:
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            materialize_case(root, workspace, case)
            argv = self.command(root, contract, case)
            deadline = contract.timeout_seconds + self.spec.startup_allowance_seconds
            try:
                completed = self._runner(argv, case.stdin_text, deadline)
            except subprocess.TimeoutExpired as error:
                raise VerifierError(
                    f"case {case.case_id}: sandbox container did not return "
                    "within the spawn allowance"
                ) from error
            except OSError as error:
                raise VerifierError(
                    f"case {case.case_id}: sandbox spawn failed"
                ) from error
        if completed.returncode in DOCKER_FAULT_EXIT_CODES and (
            "docker:" in completed.stderr or "OCI runtime" in completed.stderr
        ):
            raise VerifierError(
                f"case {case.case_id}: sandbox fault "
                f"(exit {completed.returncode}): {completed.stderr.strip()}"
            )
        if completed.returncode == CASE_TIMEOUT_EXIT_CODE:
            return "timeout"
        if completed.returncode != case.expected_exit_code:
            return "exit-code-mismatch"
        if completed.stdout != case.expected_stdout:
            return "stdout-mismatch"
        if case.expect_stderr and not completed.stderr.strip():
            return "stderr-missing"
        return "pass"
