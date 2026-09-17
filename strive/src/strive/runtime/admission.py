"""Pinned admission rules and trusted artifact provenance, outside the wire schema.

Only execution composition owns the grant writer. A candidate supplies bytes or
handles; scope labels and possession of a CAS digest confer no read authority.
"""
from dataclasses import dataclass
from pathlib import Path
import sqlite3
from typing import Protocol

from ..codec import encode
from ..contracts.primitives import AccessScope, ArtifactRef, ResourceQuantity, ScopedArtifact
from ..errors import VerificationError
from ..store.cas import CAS, durable_directory, fsync_directory
from ..verify.engine import VerifiedState


@dataclass(frozen=True)
class ValidatedArguments:
    environment: ArtifactRef
    references: tuple[ArtifactRef, ...] = ()


class ArgumentValidator(Protocol):
    @property
    def identity(self) -> ArtifactRef: ...
    def validate(self, data: bytes) -> ValidatedArguments: ...


@dataclass(frozen=True)
class AdmissionRule:
    binding: str
    operation: str
    destination: str
    scope: AccessScope
    adapter: ArtifactRef
    schema: ArtifactRef
    max_argument_bytes: int
    max_inputs: int
    bounds: tuple[ResourceQuantity, ...]
    candidate_visible_output: bool = False

    def retained(self) -> tuple[object, ...]:
        return tuple(getattr(self, key) for key in self.__dataclass_fields__)


class ArtifactProvenance:
    """Durable grants minted by trusted projection/staging code, never candidates.

    Environment-scoped grants expire at the next head. The source is retained
    for audit; it is not interpreted as a candidate's assertion of provenance.
    """
    def __init__(self, root: Path, objects: CAS, identity: ArtifactRef) -> None:
        durable_directory(root)
        self.objects, self.identity = objects, identity
        self.db = sqlite3.connect(root / "provenance.sqlite")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS grants (identity TEXT, artifact TEXT, scope BLOB, environment TEXT, source TEXT, purpose TEXT, PRIMARY KEY(identity,artifact,scope,environment,purpose))")
        self.db.commit()
        fsync_directory(root)

    def publish(self, data: bytes, scope: AccessScope, source: ArtifactRef,
                environment: ArtifactRef, *, purpose: str = "argument") -> ArtifactRef:
        self.objects.read(source)
        self.objects.read(environment)
        ref = self.objects.publish(data)
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO grants VALUES (?,?,?,?,?,?)",
                (self.identity.digest, ref.digest, encode(scope), environment.digest, source.digest, purpose))
        return ref

    def permits(self, reference: ArtifactRef, scope: AccessScope, environment: ArtifactRef | None, *, purpose: str = "argument") -> bool:
        if environment is None:
            return False
        row = self.db.execute("SELECT source FROM grants WHERE identity=? AND artifact=? AND scope=? AND environment=? AND purpose=?",
            (self.identity.digest, reference.digest, encode(scope), environment.digest, purpose)).fetchone()
        if row is None:
            return False
        self.objects.read(ArtifactRef(str(row[0])))
        self.objects.read(reference)
        return True

    def close(self) -> None:
        self.db.close()


class ScopedAdmission:
    def __init__(self, objects: CAS, provenance: ArtifactProvenance,
                 rules: tuple[AdmissionRule, ...], validators: tuple[ArgumentValidator, ...]) -> None:
        self.objects, self.provenance, self.rules = objects, provenance, rules
        self.validators = {v.identity: v for v in validators}
        if len(self.validators) != len(validators):
            raise ValueError("duplicate argument validator")
        for rule in rules:
            objects.read(rule.schema)
            if rule.schema not in self.validators or min(rule.max_argument_bytes, rule.max_inputs) < 0:
                raise ValueError("invalid scoped admission rule")
        source = objects.publish(Path(__file__).read_bytes())
        self.identity = objects.publish(encode(("scoped-admission/1", source, provenance.identity,
                                               tuple(r.retained() for r in rules))))

    def permits_input(self, state: VerifiedState, item: ScopedArtifact) -> bool:
        if not any(rule.scope == item.access_scope for rule in self.rules):
            return False
        # Recorded adapter outputs are projections. State/receipt references and
        # candidate annotations are deliberately absent from this read grant.
        if any(e.response == item.reference and e.authorization.permitted_scope == item.access_scope
               and any(r.candidate_visible_output and r.scope == item.access_scope and r.operation == e.authorization.operation
                       and r.adapter == e.authorization.adapter for r in self.rules) for e in state.effects):
            self.objects.read(item.reference)
            return True
        return self.provenance.permits(item.reference, item.access_scope, state.environment, purpose="view")

    def admit(self, state: VerifiedState, binding: str, operation: str, destination: str,
              scope: AccessScope, arguments: ArtifactRef, inputs: tuple[ArtifactRef, ...],
              adapter: ArtifactRef) -> AdmissionRule:
        rules = [r for r in self.rules if (r.binding, r.operation, r.destination, r.scope, r.adapter)
                 == (binding, operation, destination, scope, adapter)]
        if len(rules) != 1:
            raise VerificationError("no unique scoped admission rule")
        rule = rules[0]
        data = self.objects.read(arguments)
        if len(data) > rule.max_argument_bytes or len(inputs) > rule.max_inputs:
            raise VerificationError("scoped request bounds exceeded")
        if not self.provenance.permits(arguments, scope, state.environment):
            raise VerificationError("argument provenance/scope not permitted")
        validated = self.validators[rule.schema].validate(data)
        if validated.environment != state.environment:
            raise VerificationError("request does not name the current environment")
        if any(not self.permits_input(state, ScopedArtifact(ref, scope)) for ref in inputs) or any(
                not self.provenance.permits(ref, scope, state.environment, purpose="operand")
                and not self.permits_input(state, ScopedArtifact(ref, scope)) for ref in validated.references):
            raise VerificationError("artifact provenance/scope not permitted")
        return rule
