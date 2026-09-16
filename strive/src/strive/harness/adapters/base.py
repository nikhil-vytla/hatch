"""Backend adapters depend on frozen contracts and pinned decoding, not runtime."""
from pathlib import Path
import inspect

from ...codec import decode, encode
from ...contracts.annotations import Annotation
from ...contracts.bindings import ModelBinding
from ...contracts.harness import (
    CompletionClassification, ConfinementRequirements, DefinitelyNotDispatched, DurableEvidence,
    ExecutionContext, GenerationInput, HarnessDescriptor, HarnessReturn, Indeterminate,
    PreparedGeneration, ProcessObservations, ReconciliationResult, RecordedReturn, SupervisorServices, Unsupported,
)
from ...contracts.lifecycle import RecoveryCapability
from ...contracts.primitives import ArtifactRef, IntegrationLevel, Resource
from ...store.cas import CAS
from ..decoding import native_text, proposal
from ..profiles import DISABLED, LaunchProfile
from ..provider import ProviderContract


class TextHarnessAdapter:
    output_schema = b"typed-proposal/1"

    def decode_text(self, text: str) -> bytes:
        return proposal(text)

    def native_identifier(self) -> str:
        return (self.provider.provider + "/" + self.provider.model
                if self.profile.backend == "opencode" else self.provider.model)

    def __init__(self, objects: CAS, profile: LaunchProfile, provider: ProviderContract) -> None:
        self.objects, self.profile, self.provider = objects, profile, provider
        self.bound = objects.publish(provider.retained())
        self.decoder = objects.publish(encode((self.output_schema.decode(), profile.backend,
            objects.publish(Path(__file__).parent.parent.joinpath("decoding.py").read_bytes()), provider.deterministic_decoder)))
        self._profile_reference = self.profile.retained(objects)
        sources = tuple(objects.publish(path.read_bytes()) for path in sorted(Path(__file__).parent.parent.rglob("*.py")))
        implementation = objects.publish(Path(inspect.getfile(type(self))).read_bytes())
        self.identity = objects.publish(encode((implementation, sources, self.profile.retained(objects), self.decoder, self.bound)))

    def describe(self) -> HarnessDescriptor:
        _, _, sandbox = self.profile.references(self.objects)
        return HarnessDescriptor("strive.harness/1", self.profile.backend, frozenset({IntegrationLevel.MODEL}),
            (self.profile.version,), (self.provider.protocol,),
            ConfinementRequirements(True, True, True, True, True, True, DISABLED, sandbox), self.bound,
            self.decoder, frozenset({RecoveryCapability.OPERATION_LOOKUP, RecoveryCapability.SUSPEND}))

    def prepare(self, binding: ModelBinding[ArtifactRef], generation_input: GenerationInput,
                execution_context: ExecutionContext) -> PreparedGeneration | Unsupported:
        if self.profile.retained(self.objects) != self._profile_reference:
            return Unsupported("executable/configuration closure changed")
        if (binding != generation_input.requested_model_binding or binding.provider != self.provider.provider
                or binding.model != self.provider.model or binding.max_input_tokens < self.provider.input_ceiling
                or binding.max_output_tokens != self.provider.output_ceiling):
            return Unsupported("model binding differs from the pinned provider whole-generation bound")
        if any(item.access_scope != execution_context.evidence_scope for item in generation_input.authorized_context):
            return Unsupported("context scope mismatch")
        if generation_input.generation_settings != binding.request_options:
            return Unsupported("generation settings differ from binding")
        if self.objects.read(binding.request_options) != b"{}" or self.objects.read(generation_input.output_schema) != self.output_schema:
            return Unsupported("unqualified generation settings or output decoder")
        if self.profile.deadline_seconds * 1000 > self.provider.wall_milliseconds:
            return Unsupported("local harness deadline exceeds whole-generation reservation")
        bounds = {q.resource: q.quantity for q in self.provider.reservation(self.bound).components}
        bounds[Resource.TOKENS] = self.provider.input_ceiling + self.provider.output_ceiling
        if any(q.quantity < bounds.get(q.resource, 0) for q in generation_input.resource_limits):
            return Unsupported("generation resource limit cannot cover the provider bound")
        content = tuple(self.objects.read(item.reference) for item in generation_input.authorized_context)
        if sum(map(len, content)) > self.provider.max_request_bytes:
            return Unsupported("submitted context exceeds request byte quota")
        try:
            b"\n".join(content).decode("utf-8")
        except UnicodeDecodeError:
            return Unsupported("text protocol requires UTF-8 context")
        executable, config, sandbox = self.profile.references(self.objects)
        return PreparedGeneration(execution_context, (str(self.profile.executable), *self.profile.arguments),
            b"\n".join(content), config, (self.identity, self.bound, self.decoder, self.profile.retained(self.objects)),
            executable, sandbox, self.decoder, self.profile.deadline_seconds, self.provider.reservation(self.bound))

    def invoke(self, prepared_generation: PreparedGeneration, supervisor_services: SupervisorServices) -> HarnessReturn:
        process = supervisor_services.launch_confined(prepared_generation)
        try:
            supervisor_services.enforce_deadline(process, prepared_generation.deadline_seconds)
            streams = supervisor_services.capture_bounded(process, self.profile.output_limit)
        finally:
            supervisor_services.cancel(process)
        raw = self.objects.read(streams.stdout)
        decoded = None
        completion = CompletionClassification.INCOMPLETE
        try:
            if streams.observations.exit_code == 0 and not streams.observations.output_truncated:
                decoded = self.objects.publish(self.decode_text(native_text(self.profile.backend, raw)))
                completion = CompletionClassification.COMPLETE
        except (ValueError, RuntimeError):
            pass
        return HarnessReturn(completion, (streams.stdout, streams.stderr), decoded, streams.observations, (),
                             (Annotation("harness.diagnostics", b'{"usage_authority":false}'),))

    def reconcile(self, prepared_generation: PreparedGeneration, durable_evidence: DurableEvidence) -> ReconciliationResult:
        if durable_evidence.execution_context != prepared_generation.execution_context:
            return Indeterminate((), "stale effect or epoch")
        for ref in durable_evidence.captured_harness_returns:
            result = decode(self.objects.read(ref))
            if isinstance(result, HarnessReturn):
                return RecordedReturn(ref, result)
        for ref in durable_evidence.gateway_records:
            proof = decode(self.objects.read(ref))
            if isinstance(proof, tuple) and len(proof) == 3 and proof[:2] == ("no-upstream", prepared_generation.execution_context):
                return DefinitelyNotDispatched(ref)
        if durable_evidence.captured_provider_responses and self.provider.deterministic_decoder:
            raw = self.objects.read(durable_evidence.captured_provider_responses[0])
            try:
                decoded = self.objects.publish(self.decode_text(self.provider.text(raw)))
            except (ValueError, RuntimeError):
                return Indeterminate(durable_evidence.captured_provider_responses, "provider output cannot reconstruct pinned decoder")
            result = HarnessReturn(CompletionClassification.COMPLETE, (), decoded,
                ProcessObservations(None, None, False, False, False, 0), durable_evidence.captured_provider_responses)
            return RecordedReturn(self.objects.publish(encode(result)), result)
        return Indeterminate(durable_evidence.gateway_records, "potentially performed or nondeterministic decoder; retain obligation")
