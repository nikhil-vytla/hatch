"""Presentation mappings; policy and authority data are unchanged."""
from ..contracts.manifest import TelemetryProfile

SEMCONV = "1.41.0"
SCHEMA_URL = "https://opentelemetry.io/schemas/1.41.0"


def profile_attributes(profile: TelemetryProfile, attributes: dict[str, object]) -> dict[str, object]:
    result = dict(attributes)
    operation = str(attributes.get("gen_ai.operation.name", ""))
    kind = {"generate_content": "generation", "invoke_agent": "agent", "invoke_workflow": "chain",
            "execute_tool": "tool"}.get(operation, "event")
    if profile is TelemetryProfile.LANGFUSE:
        result["langfuse.observation.type"] = kind
        result["langfuse.session.id"] = attributes["strive.run.id"]
        for key in ("run.id", "campaign", "arm", "role", "phase", "revision", "evidence_scope"):
            if "strive." + key in attributes:
                result["langfuse.observation.metadata." + key] = attributes["strive." + key]
        for source, target in (("strive.request.text", "langfuse.observation.input"),
                               ("strive.response.text", "langfuse.observation.output")):
            if source in attributes:
                result[target] = attributes[source]
    return result
