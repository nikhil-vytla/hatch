"""One read-only projection to OTLP/HTTP JSON, with disposable export cursors."""
from dataclasses import dataclass
import hashlib
import http.client
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit

from ..cli.data import integer, json_bytes, read_json, write_json
from ..cli.resolve import load_manifest
from ..codec import decode
from ..contracts.harness import GenerationInput
from ..contracts.annotations import Annotation
from ..contracts.manifest import TelemetryProfile
from ..contracts.primitives import Resource
from ..contracts.records import EffectObservationSettlement, Measurement, OutcomeStatus, ProducerKind
from ..errors import VerificationError
from ..store import RunReader
from ..report.access import authorize
from ..report.model import observed_model
from ..report.snapshot import snapshot
from .profiles import SCHEMA_URL, SEMCONV, profile_attributes


def identifier(value: str, size: int) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:size]


def attributes(values: dict[str, object]) -> list[dict[str, object]]:
    def value(v: object) -> dict[str, object]:
        if type(v) is bool:
            return {"boolValue": v}
        if type(v) is int:
            return {"intValue": str(v)}
        if type(v) is float:
            return {"doubleValue": v}
        return {"stringValue": v if isinstance(v, str) else json_bytes(v).decode()}
    return [{"key": k, "value": value(v)} for k, v in sorted(values.items()) if v is not None]


@dataclass(frozen=True)
class Span:
    trace: str
    identity: str
    parent: str | None
    name: str
    kind: int
    start: int
    end: int
    fields: dict[str, object]
    events: tuple[dict[str, object], ...] = ()
    error: bool = False

    def otlp(self, profile: TelemetryProfile) -> dict[str, object]:
        value: dict[str, object] = {"traceId": self.trace, "spanId": self.identity, "name": self.name,
            "kind": self.kind, "startTimeUnixNano": str(self.start), "endTimeUnixNano": str(self.end),
            "attributes": attributes(profile_attributes(profile, self.fields)), "events": list(self.events),
            "status": {"code": 2 if self.error else 0}}
        if self.parent is not None:
            value["parentSpanId"] = self.parent
        return value


def project(read: RunReader) -> tuple[Span, ...]:
    authorize(read)
    read = snapshot(read)
    state = read.verify()
    assert state.binding is not None
    manifest = load_manifest(read.objects, state.binding.resolved_manifest)
    context: dict[str, object] = {"campaign": read.authority.run_id, "arm": "standalone"}
    for record in state.records:
        if isinstance(record.payload, Annotation) and record.payload.namespace == "workflow.context" and record.envelope.producer_identity.kind is ProducerKind.RUN_SETUP:
            context = read_json(record.payload.payload)
            break
    result: list[Span] = []
    clock = 0
    for effect in state.effects:
        auth = effect.authorization
        trace = identifier(str(read.authority.run_id) + ":" + str(effect.invocation_id), 32)
        base = str(read.authority.run_id) + ":" + str(auth.effect_id)
        workflow = identifier(base + ":workflow", 16)
        agent = identifier(base + ":agent", 16)
        leaf = identifier(base + ":operation", 16)
        fields: dict[str, object] = {"strive.run.id": read.authority.run_id, "strive.effect.id": auth.effect_id,
            "strive.campaign": context.get("campaign"), "strive.arm": context.get("arm"),
            "strive.invocation.id": effect.invocation_id, "strive.revision": auth.executing_bundle.digest,
            "strive.evidence_scope": auth.permitted_scope.lineage_id, "strive.epoch": auth.execution_epoch,
            "strive.event.id": effect.last_record_id, "strive.outcome": effect.outcome.value if effect.outcome else "pending",
            "strive.semconv.version": SEMCONV, "strive.time.basis": "relative journal-observed durations; absolute dispatch time unavailable"}
        generation: GenerationInput | None = None
        if auth.generation_envelope is not None:
            envelope = decode(read.objects.read(auth.generation_envelope))
            if isinstance(envelope, tuple):
                generation = next((v for v in envelope if isinstance(v, GenerationInput)), None)
        role = generation.role.value if generation else "actor" if auth.operation == "runtime.step" else "tool"
        fields["strive.role"] = role
        fields["strive.model.binding"] = role if generation else "none"
        fields["strive.phase"] = "audit" if auth.permitted_scope.lineage_id == "audit" else "refinement" if role == "refiner" else "acting"
        operation = "generate_content" if generation else "invoke_agent" if auth.operation == "runtime.step" else "execute_tool"
        values = {q.resource: q.quantity for q in effect.measured}
        duration = values.get(Resource.WALL_MILLISECONDS)
        end = clock + (duration or 0) * 1000000
        if duration is not None:
            fields["strive.observed.duration_ms"] = duration
        events: list[dict[str, object]] = []
        for record in state.records:
            if record.envelope.causal_identity.effect_id == auth.effect_id or record.envelope.record_id == effect.last_record_id:
                events.append({"name": "strive." + record.envelope.record_class.value,
                    "timeUnixNano": str(end), "attributes": attributes({"strive.event.id": record.envelope.record_id,
                        "strive.artifact": record.envelope.payload_reference.digest})})
        error = effect.outcome in {OutcomeStatus.FAILED, OutcomeStatus.UNCERTAIN}
        result.append(Span(trace, workflow, None, "invoke_workflow strive", 1, clock, end,
                           {**fields, "gen_ai.operation.name": "invoke_workflow"}, tuple(events), error))
        if generation is not None:
            result.append(Span(trace, agent, workflow, "invoke_agent " + role, 1, clock, end,
                {**fields, "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": role}, error=error))
            binding = generation.requested_model_binding
            fields.update({"gen_ai.request.model": binding.model, "gen_ai.provider.name": binding.provider})
            for r, key in ((Resource.INPUT_TOKENS, "gen_ai.usage.input_tokens"), (Resource.OUTPUT_TOKENS, "gen_ai.usage.output_tokens")):
                if r in values:
                    fields[key] = values[r]
            for record in state.records:
                payload = record.payload
                if isinstance(payload, EffectObservationSettlement) and payload.effect_id == auth.effect_id and payload.observed_model_identity:
                    fields["gen_ai.response.model"] = payload.observed_model_identity.model
            observed, identity_ref, response = observed_model(read, effect)
            if observed is not None:
                fields["gen_ai.response.model"] = observed.model
            if identity_ref is not None:
                fields["strive.observed.model.evidence"] = identity_ref.digest
            if auth.actual_provider_request_reference is not None:
                fields["strive.request.text"] = read.objects.read(auth.actual_provider_request_reference).decode()
                fields["strive.request.label"] = "sent to the model"
            if response is not None:
                fields["strive.response.text"] = response.decode(errors="backslashreplace")
            elif effect.response is not None:
                fields["strive.response.text"] = read.objects.read(effect.response).decode(errors="backslashreplace")
            # Leaf only, never cumulative or parent financial totals.
            if Resource.USD_NANODOLLARS in values:
                fields["strive.calculated_cost_nanodollars"] = values[Resource.USD_NANODOLLARS]
            observations: dict[str, object] = {}
            if duration is not None:
                observations["gen_ai.client.operation.duration"] = duration / 1000
            for key in ("gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"):
                if key in fields:
                    observations["gen_ai.client.token.usage." + key.rsplit(".", 1)[1]] = fields[key]
            fields["strive.metric_observations"] = observations
        elif operation == "execute_tool":
            fields["gen_ai.tool.name"] = auth.operation
        else:
            fields["gen_ai.agent.name"] = "actor"
        fields["gen_ai.operation.name"] = operation
        result.append(Span(trace, leaf, agent if generation else workflow, operation + " " + (
            generation.requested_model_binding.model if generation else auth.operation), 3 if generation else 1,
            clock, end, fields, error=error))
        clock = end
    # Measurements/revisions/annotations without an effect retain their own
    # bounded diagnostic span and exact authority event, never financial totals.
    for record in state.records:
        if record.envelope.causal_identity.effect_id is not None:
            continue
        event = record.envelope.record_id
        fields = {"strive.run.id": read.authority.run_id, "strive.event.id": event,
            "strive.campaign": context.get("campaign"), "strive.arm": context.get("arm"),
            "strive.evidence_scope": read.authority.scope.lineage_id, "strive.artifact": record.envelope.payload_reference.digest,
            "strive.producer": record.envelope.producer_identity.kind.value, "strive.semconv.version": SEMCONV}
        if isinstance(record.payload, Measurement):
            fields["strive.measurement.value"] = str(record.payload.metric_value)
        result.append(Span(identifier(event, 32), identifier(event, 16), None, "strive." + record.envelope.record_class.value,
                           1, clock, clock, fields))
    return tuple(result)


def project_metrics(read: RunReader) -> dict[str, object]:
    """Cumulative histograms reconstructed from final per-effect journal usage."""
    groups: dict[tuple[str, str, str, str], list[float]] = {}
    for span in project(read):
        values = span.fields
        if values.get("gen_ai.operation.name") != "generate_content":
            continue
        provider, model = str(values["gen_ai.provider.name"]), str(values["gen_ai.request.model"])
        if "strive.observed.duration_ms" in values:
            groups.setdefault(("gen_ai.client.operation.duration", provider, model, ""), []).append(
                integer(values["strive.observed.duration_ms"]) / 1000)
        for kind in ("input", "output"):
            key = "gen_ai.usage." + kind + "_tokens"
            if key in values:
                groups.setdefault(("gen_ai.client.token.usage", provider, model, kind), []).append(float(integer(values[key])))
    metrics: list[dict[str, object]] = []
    for (name, provider, model, kind), samples in groups.items():
        labels: dict[str, object] = {"gen_ai.operation.name": "generate_content", "gen_ai.provider.name": provider,
                                     "gen_ai.request.model": model}
        if kind:
            labels["gen_ai.token.type"] = kind
        metrics.append({"name": name, "unit": "s" if not kind else "{token}", "histogram": {
            "aggregationTemporality": 2, "dataPoints": [{"attributes": attributes(labels), "startTimeUnixNano": "0",
                "timeUnixNano": "0", "count": str(len(samples)), "sum": sum(samples), "min": min(samples),
                "max": max(samples), "explicitBounds": [], "bucketCounts": [str(len(samples))]}]}})
    return {"resourceMetrics": [{"resource": {"attributes": attributes({"service.name": "strive",
        "strive.time.basis": "relative journal-observed duration", "strive.run.id": read.authority.run_id})},
        "scopeMetrics": [{"scope": {"name": "strive.journal", "version": SEMCONV}, "schemaUrl": SCHEMA_URL,
                          "metrics": metrics}], "schemaUrl": SCHEMA_URL}]}


class Exporter(Protocol):
    def export(self, destination: str, payload: dict[str, object]) -> None: ...


class MemoryExporter:
    def __init__(self) -> None:
        self.spans: dict[tuple[str, str], dict[str, object]] = {}
        self.unavailable = False
        self.metrics: dict[str, dict[str, object]] = {}

    def export(self, destination: str, payload: dict[str, object]) -> None:
        if self.unavailable:
            raise OSError("fixture exporter unavailable")
        from ..cli.data import mapping, sequence
        if "resourceMetrics" in payload:
            self.metrics[destination] = payload
            return
        for resource in sequence(payload["resourceSpans"]):
            for scope in sequence(mapping(resource)["scopeSpans"]):
                for value in sequence(mapping(scope)["spans"]):
                    span = mapping(value)
                    self.spans[(destination, str(span["spanId"]))] = span


class HTTPExporter:
    """Invoked only by the separate projector command; no automatic retries."""
    def __init__(self, endpoint: str, headers: dict[str, str] | None = None,
                 *, development_endpoint: str | None = None) -> None:
        self.endpoint, self.headers = endpoint, headers or {}
        self.development_endpoint = development_endpoint

    def export(self, destination: str, payload: dict[str, object]) -> None:
        route = urlsplit(self.endpoint)
        if route.scheme != "https" or route.username or route.password or route.query or route.fragment:
            raise VerificationError("explicit HTTPS OTLP endpoint required")
        if destination.startswith("audit:"):
            development = urlsplit(self.development_endpoint or "")
            def address(url: object) -> tuple[str, int, str]:
                # urlsplit's typed result is used at the two calls below.
                from urllib.parse import SplitResult
                assert isinstance(url, SplitResult)
                return ((url.hostname or "").lower(), url.port or 443, url.path.rstrip("/"))
            if not self.development_endpoint or development.scheme != "https" or address(route) == address(development):
                raise VerificationError("audit HTTP export requires a distinct declared development endpoint")
        if route.hostname is None:
            raise VerificationError("OTLP endpoint requires a host")
        connection = http.client.HTTPSConnection(route.hostname, route.port, timeout=5)
        try:
            path = route.path
            if "resourceMetrics" in payload:
                if not path.endswith("/v1/traces"):
                    raise VerificationError("metric export requires an explicit /v1/traces endpoint")
                path = path.removesuffix("traces") + "metrics"
            connection.request("POST", path, json_bytes(payload), {"Content-Type": "application/json", **self.headers})
            response = connection.getresponse()
            if response.status != 200:
                raise OSError("OTLP export failed: " + str(response.status))
            body = response.read()
            if body and read_json(body).get("partialSuccess"):
                raise OSError("OTLP partial success; retain backlog")
        finally:
            connection.close()


class Projector:
    def __init__(self, read: RunReader, cursor: Path, exporter: Exporter, *, destination: str = "development:local",
                 profile: TelemetryProfile | None = None, audit_release: Path | None = None,
                 metric_exporter: Exporter | None = None) -> None:
        self.read, self.cursor, self.exporter, self.destination = read, cursor, exporter, destination
        self.metric_exporter = metric_exporter
        binding = snapshot(read).verify().binding
        assert binding is not None
        self.profile = profile or load_manifest(read.objects, binding.resolved_manifest).configuration.telemetry.profile
        if read.authority.scope.lineage_id == "audit":
            if not destination.startswith("audit:") or audit_release is None or read_json(audit_release.read_bytes())["destination"] != destination:
                raise VerificationError("audit telemetry requires authorized release and separate destination")
        elif destination.startswith("audit:"):
            raise VerificationError("development exporter cannot share the audit destination")

    def flush(self, *, rebuild: bool = False) -> dict[str, object]:
        read = snapshot(self.read)
        state = read.verify()
        previous = cursor_status(self.cursor, len(state.records))
        if previous.get("profile") not in {None, self.profile.value} or previous.get("destination") not in {None, self.destination}:
            previous = {"cursor": 0, "backlog": len(state.records), "rebuildable": True}
        if not rebuild and previous.get("head") == (state.head.digest if state.head else None) and previous.get("profile") == self.profile.value and previous.get("destination") == self.destination:
            return previous
        spans = project(read)
        payload: dict[str, object] = {"resourceSpans": [{"resource": {"attributes": attributes({"service.name": "strive", "strive.run.id": self.read.authority.run_id})},
            "scopeSpans": [{"scope": {"name": "strive.journal", "version": SEMCONV}, "schemaUrl": SCHEMA_URL,
                            "spans": [span.otlp(self.profile) for span in spans]}], "schemaUrl": SCHEMA_URL}]}
        try:
            self.exporter.export(self.destination, payload)
            if self.metric_exporter is not None:
                self.metric_exporter.export(self.destination, project_metrics(read))
        except Exception as error:
            # No execution callback and no journal append is reachable here.
            return {**previous, "backlog": len(state.records) - integer(previous["cursor"]), "error": str(error)}
        result: dict[str, object] = {"cursor": len(state.records), "backlog": 0, "head": state.head.digest if state.head else None,
                  "profile": self.profile.value, "destination": self.destination, "spans": len(spans)}
        write_json(self.cursor, result, replace=True)
        return result


def cursor_status(path: Path, records: int) -> dict[str, object]:
    try:
        value = read_json(path.read_bytes())
        cursor = integer(value["cursor"])
        if cursor > records:
            raise ValueError("cursor beyond history")
        return {**value, "backlog": records - cursor}
    except (OSError, ValueError, KeyError, VerificationError):
        return {"cursor": 0, "backlog": records, "rebuildable": True}
