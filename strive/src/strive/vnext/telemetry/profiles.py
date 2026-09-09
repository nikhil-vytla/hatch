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
    elif profile is TelemetryProfile.LANGSMITH:
        result["langsmith.span.kind"] = "llm" if kind == "generation" else "chain" if kind in {"agent", "chain", "event"} else kind
        result["langsmith.trace.session_name"] = attributes.get("strive.campaign", attributes["strive.run.id"])
        for k, v in attributes.items():
            if k.startswith("strive."):
                result["langsmith.metadata." + k[7:]] = v
        for source, target in (("strive.request.text", "gen_ai.prompt"), ("strive.response.text", "gen_ai.completion")):
            if source in attributes:
                result[target] = attributes[source]
    else:
        result["openinference.span.kind"] = "LLM" if kind == "generation" else "AGENT" if kind == "agent" else "TOOL" if kind == "tool" else "CHAIN"
        for source, target in (("gen_ai.request.model", "llm.model_name"),
                               ("gen_ai.provider.name", "llm.provider"),
                               ("gen_ai.usage.input_tokens", "llm.token_count.prompt"),
                               ("gen_ai.usage.output_tokens", "llm.token_count.completion"),
                               ("strive.request.text", "input.value"), ("strive.response.text", "output.value")):
            if source in attributes:
                result[target] = attributes[source]
        result["session.id"] = attributes["strive.run.id"]
    return result
