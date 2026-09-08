"""Public-API composition around the unchanged M3 supervisor.

The frozen Receipt has no execution-status field. Known usage is settled by M3
first; a durable gateway qualification stop then commits ordinary Suspend. This
keeps real billing even on a model mismatch, without forging an overrun or
modifying the supervisor's accounting/recovery logic.
"""
from ..contracts.commands import StepOutput, Suspend
from ..contracts.primitives import ExecutionStatus
from ..errors import VerificationError
from ..runtime.supervisor import Supervisor
from .bridge import HarnessEffectAdapter


class HarnessExecution:
    def __init__(self, supervisor: Supervisor, adapters: tuple[HarnessEffectAdapter, ...]) -> None:
        self.supervisor, self.adapters = supervisor, adapters

    def _fence(self) -> str | None:
        run = self.supervisor.writer.reader.authority.scope.run_id
        reasons = [reason for adapter in self.adapters if (reason := adapter.gateway.stop_reason(run)) is not None]
        if not reasons:
            return None
        if self.supervisor.state.execution_status is ExecutionStatus.CONTINUE:
            self.supervisor.accept(StepOutput(Suspend(reasons[0]), self.supervisor.state.private_state),
                                   expected_head=self.supervisor.state.head)
        return reasons[0]

    def drive(self) -> None:
        try:
            self.supervisor.drive()
        except Exception:
            # A process error may coexist with a captured provider response.
            # M3 alone decides whether lookup/settlement is permitted; it will
            # never re-invoke an ambiguous effect. Preserve the original error.
            self.supervisor.recover()
            self._fence()
            raise
        reason = self._fence()
        if reason is not None:
            raise VerificationError(reason)

    def recover(self) -> None:
        self.supervisor.recover()
        self._fence()
