"""Read observed model identity from authenticated retained gateway receipts."""
from ..codec import decode
from ..contracts.primitives import ArtifactRef, ObservedModelIdentity
from ..contracts.records import EffectObservationSettlement
from ..errors import VerificationError
from ..store import RunReader
from ..verify.engine import EffectView


def observed_model(read: RunReader, effect: EffectView) -> tuple[ObservedModelIdentity | None, ArtifactRef | None, bytes | None]:
    for record in read.verify().records:
        payload = record.payload
        if not isinstance(payload, EffectObservationSettlement) or payload.effect_id != effect.authorization.effect_id:
            continue
        if payload.observed_model_identity is not None:
            observed = payload.observed_model_identity
            return observed, payload.identity_provenance, read.objects.read(observed.provenance)
        for ref in payload.receipt_references:
            try:
                receipt = decode(read.objects.read(ref))
            except VerificationError:
                continue  # Other pinned adapters may retain opaque receipt bytes.
            if not isinstance(receipt, tuple) or not receipt:
                continue
            identity_ref = None
            if receipt[0] in {"refiner-receipt/1", "direct-user-receipt/1"} and len(receipt) == 6:
                identity_ref = receipt[5]
            elif receipt[0] == "gateway-receipt/1" and len(receipt) == 8:
                identity_ref = receipt[4]
            if not isinstance(identity_ref, ArtifactRef):
                continue
            identity = decode(read.objects.read(identity_ref))
            if not isinstance(identity, tuple) or len(identity) != 9 or identity[0] != "gateway-model-identities/1":
                raise VerificationError("malformed retained gateway identity")
            if identity[6] != effect.authorization.actual_provider_request_reference:
                raise VerificationError("observed identity does not match the authorized wire request")
            observed = identity[3]
            if observed is None:
                return None, identity_ref, None
            if not isinstance(observed, ObservedModelIdentity) or observed.provenance != identity[7]:
                raise VerificationError("observed identity lacks its retained provider response")
            return observed, identity_ref, read.objects.read(observed.provenance)
    return None, None, None
