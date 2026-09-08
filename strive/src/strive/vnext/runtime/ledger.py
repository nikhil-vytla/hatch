"""Admission and receipt arithmetic over the verifier's single ledger."""

from dataclasses import dataclass

from ..contracts.primitives import Reservation, Resource, ResourceQuantity
from ..contracts.records import (
    ReservationDisposition, UsageCompleteness, UsageKind, UsageObservation,
    UsageProvenance,
)
from ..contracts.primitives import ArtifactRef
from ..errors import VerificationError
from ..verify.engine import EffectView, VerifiedState


def amounts(items: tuple[ResourceQuantity, ...]) -> dict[Resource, int]:
    result = {item.resource: item.quantity for item in items}
    if len(result) != len(items):
        raise VerificationError("duplicate resource")
    return result


@dataclass(frozen=True)
class Settlement:
    usage: tuple[UsageObservation, ...]
    completeness: UsageCompleteness
    disposition: ReservationDisposition
    overrun: tuple[ResourceQuantity, ...]


class BudgetLedger:
    """No mutable balance: all balances come from verified authority records."""

    @staticmethod
    def admit(state: VerifiedState, reservation: Reservation) -> None:
        if state.binding is None or state.dispatch_stopped:
            raise VerificationError("dispatch stopped or unbound run")
        totals: dict[Resource, int] = {}
        for group in (state.measured, state.obligations, reservation.components):
            for resource, quantity in amounts(group).items():
                totals[resource] = totals.get(resource, 0) + quantity
        proposed = amounts(reservation.components)
        if Resource.TOKENS in proposed and ({Resource.INPUT_TOKENS, Resource.OUTPUT_TOKENS} & proposed.keys()):
            raise VerificationError("overlapping token reservations")
        limits = state.binding.limits
        tokens = sum(totals.get(r, 0) for r in (Resource.TOKENS, Resource.INPUT_TOKENS, Resource.OUTPUT_TOKENS))
        if (tokens > limits.tokens or totals.get(Resource.MODEL_CALLS, 0) > limits.model_calls
                or totals.get(Resource.USD_NANODOLLARS, 0) > limits.usd.nanodollars
                or totals.get(Resource.WALL_MILLISECONDS, 0) > limits.wall_seconds * 1000):
            raise VerificationError("reservation exceeds run budget")

    @staticmethod
    def settlement(effect: EffectView, measured: tuple[ResourceQuantity, ...],
                   evidence: ArtifactRef, provenance: UsageProvenance,
                   remaining: tuple[ResourceQuantity, ...] = ()) -> Settlement:
        """Receipts contain cumulative totals, never incremental charges.

        Omitted components retain their prior obligations. A supplied measured
        component is complete unless its receipt explicitly retains a remainder.
        Only a trusted adapter calls this; candidate diagnostics never do.
        """
        bounds = amounts(effect.authorization.reservation.components)
        old, held = amounts(effect.measured), amounts(effect.obligations)
        incoming, remainders = amounts(measured), amounts(remaining)
        if not incoming.keys() <= bounds.keys() or not remainders.keys() <= incoming.keys():
            raise VerificationError("receipt has unreserved resources")
        for resource, quantity in incoming.items():
            if quantity < old.get(resource, 0):
                raise VerificationError("measured usage cannot disappear")
            old[resource] = quantity
            held[resource] = remainders.get(resource, 0)
            if held[resource] > max(0, bounds[resource] - quantity):
                raise VerificationError("obligation exceeds remaining bound")
        usage = tuple(
            UsageObservation(UsageKind.MEASURED, ResourceQuantity(r, old[r]), provenance,
                             evidence, ResourceQuantity(r, held[r]) if held.get(r, 0) else None)
            if r in old else
            UsageObservation(UsageKind.UNKNOWN, None, provenance, evidence, ResourceQuantity(r, held.get(r, 0)))
            for r in sorted(bounds)
        )
        incomplete = any(held.values())
        completeness = (UsageCompleteness.PARTIAL if old else UsageCompleteness.MISSING) if incomplete else (
            UsageCompleteness.COMPLETE if bounds else UsageCompleteness.NOT_APPLICABLE)
        return Settlement(usage, completeness,
                          ReservationDisposition.REPLACE_KNOWN_COMPONENTS if incomplete else ReservationDisposition.RELEASE,
                          tuple(ResourceQuantity(r, q - bounds[r]) for r, q in sorted(old.items()) if q > bounds[r]))
