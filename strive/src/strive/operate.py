"""The injected, versioned operation driver.

Operation feedback is what a continual policy learns from: it runs the ACTIVE
harness and reports how it behaved. That feedback MUST be policy-visible only —
the hidden evaluator data (held-out / adversarial / audit cases, and any
selection-only expected answers) can never reach the Refiner, or an outage or a
leaked answer would "teach" a code change dishonestly.

An `OperationDriver` encapsulates *which* cases operating the harness exercises
and *how* their identity is exposed. The shipping `task-suite@1` driver runs
the task's VISIBLE split, RELABELLED with OPAQUE ids (`op-0`, `op-1`, …) into an
explicit ``operation`` split, so a diagnostic case name (e.g. a "negative"
label) can never leak the fix. It is injected, so a real deployment can supply
a different operation surface without touching the kernel.
"""

from __future__ import annotations

from typing import Protocol

from strive.contracts import TaskCase
from strive.tasks import Task

OPERATION_SPLIT = "operation"


class OperationDriver(Protocol):
    """A versioned strategy for operating the active harness. `operation_cases`
    returns ONLY policy-visible cases, with opaque ids — never a hidden split."""

    name: str

    def operation_cases(self, task: Task) -> tuple[TaskCase, ...]: ...


class TaskSuiteOperationDriver:
    """The shipping driver: operate the harness over the task's VISIBLE split,
    relabelled with opaque ids so neither the hidden splits nor the diagnostic
    case names ever reach the Refiner."""

    name = "task-suite@1"

    def operation_cases(self, task: Task) -> tuple[TaskCase, ...]:
        return tuple(
            TaskCase(
                case_id=f"op-{i}",
                input_text=case.input_text,
                expected=case.expected,  # a VISIBLE expected answer — not hidden
                split=OPERATION_SPLIT,
            )
            for i, case in enumerate(task.visible_cases())
        )


def default_operation_driver() -> OperationDriver:
    return TaskSuiteOperationDriver()


__all__ = [
    "OPERATION_SPLIT",
    "OperationDriver",
    "TaskSuiteOperationDriver",
    "default_operation_driver",
]
