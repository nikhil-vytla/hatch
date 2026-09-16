"""Versioned commit transport and local authentication, outside the contracts.

MAC keys are protected host metadata, not payload fields or portable signatures.
A read-only verifier is trusted with these keys. Candidates receive neither keys
nor append ports. Host compromise and replacement of the trust root are outside
this local protocol's threat model.
"""

from dataclasses import dataclass, replace
import hashlib
import hmac
from types import MappingProxyType
from typing import Iterator, Mapping, Protocol

from .codec import content_ref, decode, encode
from .contracts.primitives import AccessScope, ArtifactRef, RunId
from .contracts.records import Envelope, IntegrityLinkage, ProducerIdentity, ProducerKind, RecordClass, RecordOwner, RECORD_OWNERS
from .errors import VerificationError

FORMAT = b"strive-vnext-store/1\n"
FRAME_MAGIC = b"SVN1"
COMMIT_MAGIC = b"COMMIT1!"
MAX_FRAME_BYTES = 8 * 1024 * 1024
ZERO_REF = ArtifactRef("sha256:" + "0" * 64)

OWNER_KINDS: Mapping[RecordOwner, frozenset[ProducerKind]] = MappingProxyType({
    RecordOwner.SUPERVISOR: frozenset({ProducerKind.SUPERVISOR}),
    RecordOwner.TRUSTED_RUN_SETUP: frozenset({ProducerKind.RUN_SETUP}),
    RecordOwner.BROKER_AND_SUPERVISOR: frozenset({ProducerKind.BROKER, ProducerKind.SUPERVISOR}),
    RecordOwner.BROKER_AND_TRUSTED_ADAPTERS: frozenset({ProducerKind.BROKER, ProducerKind.TRUSTED_ADAPTER}),
    RecordOwner.TRUSTED_SCORER: frozenset({ProducerKind.TRUSTED_SCORER}),
})


class ObjectReader(Protocol):
    def read(self, reference: ArtifactRef) -> bytes: ...


@dataclass(frozen=True)
class Frame:
    epoch: int
    append_path: ProducerKind
    envelope: Envelope
    producer_mac: bytes
    supervisor_mac: bytes

    def unsigned(self) -> bytes:
        return encode((1, self.epoch, self.append_path, self.envelope))

    def to_bytes(self) -> bytes:
        return encode((1, self.epoch, self.append_path, self.envelope, self.producer_mac, self.supervisor_mac))

    @classmethod
    def from_bytes(cls, data: bytes) -> "Frame":
        value = decode(data)
        if not isinstance(value, tuple) or len(value) != 6:
            raise VerificationError("invalid commit transport")
        version, epoch, path, envelope, producer_mac, supervisor_mac = value
        if (type(version) is not int or version != 1 or type(epoch) is not int or epoch < 1
                or not isinstance(path, ProducerKind) or not isinstance(envelope, Envelope)
                or type(producer_mac) is not bytes or len(producer_mac) != 32
                or type(supervisor_mac) is not bytes or len(supervisor_mac) != 32):
            raise VerificationError("invalid commit transport fields")
        return cls(epoch, path, envelope, producer_mac, supervisor_mac)


def record_digest(envelope: Envelope, epoch: int, path: ProducerKind) -> ArtifactRef:
    neutral = replace(envelope, integrity_linkage=IntegrityLinkage(envelope.integrity_linkage.previous_record_digest, ZERO_REF))
    return content_ref(encode((1, epoch, path, neutral)))


def pack_frame(frame: Frame) -> bytes:
    body = frame.to_bytes()
    if len(body) > MAX_FRAME_BYTES:
        raise VerificationError("frame too large")
    return FRAME_MAGIC + len(body).to_bytes(8, "big") + body + hashlib.sha256(body).digest() + COMMIT_MAGIC


class JournalReader(Protocol):
    def frames(self) -> Iterator[Frame]: ...


@dataclass(frozen=True)
class Authority:
    run_id: RunId
    scope: AccessScope
    producers: Mapping[ProducerKind, ProducerIdentity]
    keys: Mapping[ProducerKind, bytes]

    def __post_init__(self) -> None:
        object.__setattr__(self, "producers", MappingProxyType(dict(self.producers)))
        object.__setattr__(self, "keys", MappingProxyType(dict(self.keys)))
        if (self.scope.run_id != self.run_id or set(self.keys) != set(self.producers)
                or ProducerKind.SUPERVISOR not in self.keys or ProducerKind.RUN_SETUP not in self.keys
                or any(kind is not producer.kind for kind, producer in self.producers.items())
                or any(len(key) != 32 for key in self.keys.values())):
            raise VerificationError("invalid local authority root")

    def check_owner(self, kind: ProducerKind, record_class: RecordClass) -> None:
        if kind not in self.producers:
            raise VerificationError("unregistered append path")
        if record_class is not RecordClass.ANNOTATION and kind not in OWNER_KINDS[RECORD_OWNERS[record_class]]:
            raise VerificationError("producer does not own record class")

    def sign(self, epoch: int, kind: ProducerKind, envelope: Envelope) -> Frame:
        self.check_owner(kind, envelope.record_class)
        frame = Frame(epoch, kind, envelope, b"", b"")
        producer_mac = hmac.digest(self.keys[kind], b"producer\0" + frame.unsigned(), "sha256")
        supervisor_mac = hmac.digest(self.keys[ProducerKind.SUPERVISOR], b"supervisor\0" + frame.unsigned() + producer_mac, "sha256")
        return replace(frame, producer_mac=producer_mac, supervisor_mac=supervisor_mac)

    def verify(self, frame: Frame) -> None:
        envelope = frame.envelope
        self.check_owner(frame.append_path, envelope.record_class)
        if envelope.producer_identity != self.producers[frame.append_path]:
            raise VerificationError("forged producer identity")
        if envelope.run_id != self.run_id or envelope.access_scope != self.scope:
            raise VerificationError("wrong run or access scope")
        expected = self.sign(frame.epoch, frame.append_path, envelope)
        if not hmac.compare_digest(expected.producer_mac, frame.producer_mac) or not hmac.compare_digest(expected.supervisor_mac, frame.supervisor_mac):
            raise VerificationError("invalid producer/supervisor authentication")
