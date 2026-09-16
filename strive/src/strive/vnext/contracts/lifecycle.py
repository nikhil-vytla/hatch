"""Pure lifecycle checks. Tables never authorize dispatch or reconciliation."""

from dataclasses import dataclass
from enum import StrEnum
from types import MappingProxyType
from typing import Final, Mapping


class EffectState(StrEnum):
    ACCEPTED = "accepted"
    AUTHORIZED_RESERVED = "authorized_reserved"
    DISPATCHED = "dispatched"
    RETURNED = "returned"
    UNCERTAIN = "uncertain"
    SETTLED = "settled"
    CONSUMED = "consumed"


# SETTLED means known components have been booked. It does not assert complete
# usage: unknown components retain reservations, even after result consumption.
LEGAL_TRANSITIONS: Final[Mapping[EffectState, frozenset[EffectState]]] = MappingProxyType({
    EffectState.ACCEPTED: frozenset({EffectState.AUTHORIZED_RESERVED}),
    EffectState.AUTHORIZED_RESERVED: frozenset({EffectState.DISPATCHED, EffectState.RETURNED, EffectState.UNCERTAIN}),
    EffectState.DISPATCHED: frozenset({EffectState.RETURNED, EffectState.UNCERTAIN}),
    EffectState.UNCERTAIN: frozenset({EffectState.RETURNED}),
    EffectState.RETURNED: frozenset({EffectState.SETTLED}),
    EffectState.SETTLED: frozenset({EffectState.CONSUMED}),
    EffectState.CONSUMED: frozenset(),
})


def validate_transition(previous: EffectState, following: EffectState) -> None:
    if following not in LEGAL_TRANSITIONS[previous]:
        raise ValueError(f"illegal effect transition: {previous} -> {following}")


class DispatchStage(StrEnum):
    OPERATION = "operation"
    HARNESS_LAUNCH = "harness_launch"
    UPSTREAM_FORWARD = "upstream_forward"


class RecoveryCapability(StrEnum):
    RECOMPUTE_DETERMINISTIC = "recompute_deterministic"
    OPERATION_LOOKUP = "operation_lookup"
    DEDUPLICATED_RETRY = "deduplicated_retry"
    SUSPEND = "suspend"


@dataclass(frozen=True, slots=True)
class RecoveryContract:
    capabilities: frozenset[RecoveryCapability]
    business_operation_deduplication: bool
    billing_deduplication: bool


class RecoveryAction(StrEnum):
    VALIDATE_AND_AUTHORIZE = "validate_and_authorize"
    RECONCILE_OR_SUSPEND = "reconcile_or_suspend"
    COMPLETE_RECORDED_BOOKKEEPING = "complete_recorded_bookkeeping"
    RESTORE_CONTINUATION = "restore_continuation"
    APPEND_LATE_RECONCILIATION = "append_late_reconciliation"
    PROVE_NO_UPSTREAM_REVOKE_TERMINATE_NEW_EPOCH = "prove_no_upstream_revoke_terminate_new_epoch"
    SETTLE_AND_DECODE_OR_PRESERVE_INCOMPLETE = "settle_and_decode_or_preserve_incomplete"


RECOVERY_ACTIONS: Final[Mapping[EffectState, RecoveryAction]] = MappingProxyType({
    EffectState.ACCEPTED: RecoveryAction.VALIDATE_AND_AUTHORIZE,
    EffectState.AUTHORIZED_RESERVED: RecoveryAction.RECONCILE_OR_SUSPEND,
    EffectState.DISPATCHED: RecoveryAction.RECONCILE_OR_SUSPEND,
    EffectState.RETURNED: RecoveryAction.COMPLETE_RECORDED_BOOKKEEPING,
    EffectState.UNCERTAIN: RecoveryAction.RECONCILE_OR_SUSPEND,
    EffectState.SETTLED: RecoveryAction.COMPLETE_RECORDED_BOOKKEEPING,
    EffectState.CONSUMED: RecoveryAction.RESTORE_CONTINUATION,
})

# Execution completion is orthogonal to effect accounting. Late receipts may
# append reconciliation, but cannot reopen execution or move a consumed cursor.
FINISHED_EXECUTION_RECOVERY_ACTION: Final = RecoveryAction.APPEND_LATE_RECONCILIATION


class HarnessInterruption(StrEnum):
    LAUNCH_AUTHORIZED_NO_UPSTREAM_AUTHORIZATION = "launch_authorized_no_upstream_authorization"
    UPSTREAM_AUTHORIZED_NO_OUTCOME = "upstream_authorized_no_outcome"
    PROVIDER_RESPONSE_CAPTURED_OUTPUT_INCOMPLETE = "provider_response_captured_output_incomplete"
    COMPLETE_RETURN_CAPTURED = "complete_return_captured"
    RESULT_CONSUMED = "result_consumed"
    LATE_RESPONSE_OR_RECEIPT = "late_response_or_receipt"


HARNESS_RECOVERY_ACTIONS: Final[Mapping[HarnessInterruption, RecoveryAction]] = MappingProxyType({
    HarnessInterruption.LAUNCH_AUTHORIZED_NO_UPSTREAM_AUTHORIZATION: RecoveryAction.PROVE_NO_UPSTREAM_REVOKE_TERMINATE_NEW_EPOCH,
    HarnessInterruption.UPSTREAM_AUTHORIZED_NO_OUTCOME: RecoveryAction.RECONCILE_OR_SUSPEND,
    HarnessInterruption.PROVIDER_RESPONSE_CAPTURED_OUTPUT_INCOMPLETE: RecoveryAction.SETTLE_AND_DECODE_OR_PRESERVE_INCOMPLETE,
    HarnessInterruption.COMPLETE_RETURN_CAPTURED: RecoveryAction.COMPLETE_RECORDED_BOOKKEEPING,
    HarnessInterruption.RESULT_CONSUMED: RecoveryAction.RESTORE_CONTINUATION,
    HarnessInterruption.LATE_RESPONSE_OR_RECEIPT: RecoveryAction.APPEND_LATE_RECONCILIATION,
})
