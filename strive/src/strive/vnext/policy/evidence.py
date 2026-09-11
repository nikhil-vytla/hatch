"""Trusted pool assignments intersect with broker grants before reading bytes."""
from dataclasses import dataclass
from collections.abc import Mapping

from ..benchmarks.bridge import OperationRequest

from ..contracts.feedback import EvidencePool, FEEDBACK_ACCESS_MATRIX
from ..contracts.primitives import ScopedArtifact
from ..contracts.records import OutcomeStatus
from ..errors import VerificationError
from ..runtime.broker import CapabilityBroker, EffectRequest
from ..verify.engine import VerifiedState
from .data import Origin


@dataclass(frozen=True)
class EvidenceView:
    origins: tuple[Origin, ...]
    contents: tuple[bytes, ...]

    @property
    def artifacts(self) -> tuple[ScopedArtifact, ...]:
        return tuple(ScopedArtifact(o.reference, o.scope) for o in self.origins)


class EvidenceSelector:
    """grants come from run setup, never from a model's proposed pool labels."""
    def __init__(self, broker: CapabilityBroker, grants: tuple[Origin, ...] = (),
                 episode_pools: Mapping[str, EvidencePool] | None = None) -> None:
        self.broker, self.grants = broker, grants
        self.episode_pools = dict(episode_pools or {})

    def allowed(self, state: VerifiedState, origin: Origin) -> bool:
        assert state.binding is not None
        feedback = state.binding.feedback_contract
        matrix = FEEDBACK_ACCESS_MATRIX[feedback.contract]
        if not matrix.implemented:
            raise VerificationError("feedback contract is not implemented")
        try:
            pool = EvidencePool(origin.pool)
        except ValueError:
            return False
        return (pool in matrix.adaptation
                and (pool is not EvidencePool.OPERATIONAL_FAILURES or feedback.operational_failures_visible)
                and self.broker.permits_input(state, ScopedArtifact(origin.reference, origin.scope)))

    def select(self, state: VerifiedState) -> EvidenceView:
        assert state.binding is not None
        # Only adapter output projections enter. Receipts, snapshots, scores,
        # annotations and private/audit pools are not implicit read grants.
        observations: list[Origin] = []
        for effect in state.effects:
            if effect.response is None or not effect.authorization.operation.startswith("benchmark."):
                continue
            request = EffectRequest.read(self.broker.objects.read(effect.authorization.exact_request_reference))
            operation = OperationRequest.read(self.broker.objects.read(request.arguments))
            pool = self.episode_pools.get(operation.episode)
            if pool is None or pool not in FEEDBACK_ACCESS_MATRIX[state.binding.feedback_contract.contract].adaptation:
                continue
            if effect.outcome is OutcomeStatus.FAILED:
                pool = EvidencePool.OPERATIONAL_FAILURES
            observations.append(Origin(effect.response, effect.authorization.permitted_scope, pool.value))
        candidates = tuple(dict.fromkeys((*self.grants, *observations)))
        accepted = tuple(o for o in candidates if self.allowed(state, o))
        return EvidenceView(accepted, tuple(self.broker.objects.read(o.reference) for o in accepted))
