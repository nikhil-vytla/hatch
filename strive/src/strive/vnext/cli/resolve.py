"""Retain authored inputs and resolve the frozen manifest before dispatch."""
from dataclasses import replace
from pathlib import Path
import platform
import sys

from ..codec import decode, encode
from ..contracts.manifest import (
    AuthoredManifest, ResolvedClosure, ResolvedManifest, ResolvedModel,
    ResolvedOperation, RunManifest, RunTable, PinsTable, PolicyTable, WorkloadTable,
    FeedbackTable, ComparisonTable, NamedModel, NamedHarness, BudgetTable,
    load_authored_manifest,
)
from ..contracts.bindings import ModelBinding
from ..contracts.primitives import ArtifactRef
from ..errors import VerificationError
from ..store.cas import CAS, CASReader
from .data import json_bytes


def retain_tree(objects: CAS, directory: Path) -> ArtifactRef:
    entries = tuple((str(p.relative_to(directory)), objects.publish(p.read_bytes()))
                    for p in sorted(directory.rglob("*"))
                    if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc")
    if not entries:
        raise VerificationError(f"empty artifact directory: {directory}")
    return objects.publish(encode(entries))


def tree(objects: CASReader, reference: ArtifactRef) -> dict[str, bytes]:
    value = decode(objects.read(reference))
    if not isinstance(value, tuple):
        raise VerificationError("expected retained file tree")
    files: dict[str, bytes] = {}
    for item in value:
        if not isinstance(item, tuple) or len(item) != 2 or not isinstance(item[0], str) or not isinstance(item[1], ArtifactRef):
            raise VerificationError("invalid retained tree entry")
        if item[0] in files:
            raise VerificationError("duplicate retained path")
        files[item[0]] = objects.read(item[1])
    return files


class Resolver:
    def __init__(self, objects: CAS, base: Path, builtins: dict[str, ArtifactRef]) -> None:
        self.objects, self.base, self.builtins = objects, base, builtins

    def reference(self, value: str) -> ArtifactRef:
        if value.startswith("sha256:"):
            reference = ArtifactRef(value)
            self.objects.read(reference)
            return reference
        if value.startswith("builtin:"):
            if value not in self.builtins:
                raise VerificationError(f"unknown pinned implementation: {value}")
            return self.builtins[value]
        path = (self.base / value).resolve()
        if path.is_dir():
            return retain_tree(self.objects, path)
        return self.objects.publish(path.read_bytes())

    def configuration(self, authored: AuthoredManifest) -> RunManifest[ArtifactRef]:
        r = self.reference
        a = authored
        if a.harnesses:
            raise VerificationError("fixture runner supports direct recorded provider only; native harness campaign remains gated")
        return RunManifest(a.schema, RunTable(a.run.mode, a.run.editable, r(a.run.capabilities)),
            PinsTable(*(r(getattr(a.pins, name)) for name in a.pins.__dataclass_fields__)),
            PolicyTable(r(a.policy.package), a.policy.entrypoint, a.policy.parameters),
            WorkloadTable(r(a.workload.implementation), r(a.workload.initial_snapshot), r(a.workload.task_stream),
                          r(a.workload.dev_corpus), r(a.workload.validation_corpus) if a.workload.validation_corpus else None),
            FeedbackTable(a.feedback.contract, a.feedback.operational_failures_visible, r(a.feedback.audit_plan), a.feedback.audit_release),
            ComparisonTable(a.comparison.strictness, r(a.comparison.plan), a.comparison.allowed_differences),
            tuple(NamedModel(m.name, ModelBinding(m.binding.provider, m.binding.model, r(m.binding.request_options),
                m.binding.max_input_tokens, m.binding.max_output_tokens, m.binding.fallback, m.binding.harness)) for m in a.models),
            tuple[NamedHarness[ArtifactRef], ...](), a.seeds,
            BudgetTable(a.budget.usd, a.budget.tokens, a.budget.model_calls, a.budget.wall_seconds,
                        r(a.budget.price_schedule), a.budget.includes), a.recovery, a.telemetry)


def runtime_identity(objects: CAS) -> ArtifactRef:
    root = Path(__file__).resolve().parents[1]
    # Retain source changes as actual bytes, including the pure verifier and the
    # composition root. No Git checkout or mutable source path is an identity.
    sources = retain_tree(objects, root)
    runtime = objects.publish(Path(sys.executable).resolve().read_bytes())
    return objects.publish(encode(("runtime-closure/1", sources, runtime,
        sys.version, platform.platform())))


def resolved(objects: CAS, source: str, configuration: RunManifest[ArtifactRef],
             initial_bundle: ArtifactRef, models: tuple[ResolvedModel, ...],
             operations: tuple[ResolvedOperation, ...], sandbox: ArtifactRef,
             dependencies: tuple[ArtifactRef, ...], schemas: tuple[ArtifactRef, ...]) -> ResolvedManifest:
    authored = objects.publish(source.encode())
    initial_state = objects.publish(b"")
    memory = tuple(objects.publish(data) for path, data in tree(objects, configuration.pins.initial_bundle).items()
                   if path.startswith(("memory/", "skills/")))
    closure = ResolvedClosure(configuration.pins.runtime, dependencies, configuration.policy.package,
        initial_state, initial_bundle, (configuration.pins.initial_bundle,), memory, schemas, sandbox,
        objects.publish(encode((configuration.workload, configuration.pins.scorer))), models, operations,
        configuration.budget.includes)
    manifest = ResolvedManifest(configuration, objects.publish(encode(configuration)), authored, closure)
    objects.publish(encode(manifest))
    return manifest


def load_manifest(objects: CASReader, reference: ArtifactRef) -> ResolvedManifest:
    value = decode(objects.read(reference))
    if not isinstance(value, ResolvedManifest):
        raise VerificationError("recorded resolved manifest is missing")
    if objects.read(value.configuration_digest) != encode(value.configuration):
        raise VerificationError("configuration digest mismatch")
    # Re-run strict authored validation as well as the frozen resolved validator.
    load_authored_manifest(objects.read(value.authored_manifest).decode())
    return replace(value)
