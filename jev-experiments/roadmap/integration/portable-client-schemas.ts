type Value = Record<string, any>;
const object = (value: unknown): Value => { if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected a retained client object."); return value as Value; };
const keys = (value: Value, allowed: readonly string[], required: readonly string[] = allowed) => {
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw Error("Unknown or incomplete retained client fields.");
};
const strings = (value: Value, names: readonly string[]) => {
  if (names.some((name) => typeof value[name] !== "string")) throw Error("Invalid retained client identity.");
};
function content(value: unknown): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) throw Error("Invalid retained client content.");
  for (const item of value) {
    const block = object(item);
    switch (block.type) {
      case "text": keys(block, ["type", "text"]); strings(block, ["text"]); break;
      case "thinking": keys(block, ["type", "thinking", "signature"]); strings(block, ["thinking", "signature"]); break;
      case "tool_use": keys(block, ["type", "id", "name", "input", "caller"], ["type", "id", "name", "input"]); strings(block, ["id", "name"]); object(block.input); break;
      case "tool_result": keys(block, ["type", "tool_use_id", "content", "is_error"], ["type", "tool_use_id", "content"]); strings(block, ["tool_use_id"]); content(block.content); break;
      default: throw Error("Unsupported retained client content type.");
    }
  }
}
/** Validate captured host envelopes; opaque tool payloads/diagnostics remain lossless. */
export function validateClientTranscript(harness: "opencode" | "claude", payload: unknown): void {
  if (!Array.isArray(payload)) throw Error("Expected transcript event array.");
  for (const value of payload) {
    const event = object(value);
    if (harness === "opencode") {
      keys(event, ["type", "timestamp", "sessionID", "part"]); strings(event, ["sessionID"]);
      if (typeof event.timestamp !== "number" || !Number.isFinite(event.timestamp)) throw Error("Invalid retained event time.");
      const part = object(event.part), common = ["id", "messageID", "sessionID", "type"];
      strings(part, ["id", "messageID", "sessionID"]);
      switch (event.type) {
        case "step_start": keys(part, common); if (part.type !== "step-start") throw Error("Invalid retained part type."); break;
        case "text": keys(part, [...common, "text", "time"]); strings(part, ["text"]); if (part.type !== "text") throw Error("Invalid retained part type."); break;
        case "tool_use": {
          keys(part, [...common, "callID", "tool", "state"]); strings(part, ["callID", "tool"]);
          if (part.type !== "tool") throw Error("Invalid retained part type.");
          const state = object(part.state);
          if (state.status === "error") keys(state, ["error", "input", "status", "time"]);
          else if (state.status === "completed") keys(state, ["input", "metadata", "output", "status", "time", "title"]);
          else throw Error("Unsupported retained tool state.");
          object(state.input); break;
        }
        case "step_finish": keys(part, [...common, "cost", "reason", "tokens"]); if (part.type !== "step-finish") throw Error("Invalid retained part type."); object(part.tokens); break;
        default: throw Error("Unsupported retained OpenCode event.");
      }
      continue;
    }
    const common = ["type", "session_id", "uuid"];
    strings(event, ["session_id", "uuid"]);
    switch (event.type) {
      case "system":
        if (event.subtype === "init") keys(event, [...common, "subtype", "agents", "analytics_disabled", "apiKeySource", "capabilities", "claude_code_version", "cwd", "fast_mode_disabled_reason", "fast_mode_state", "mcp_servers", "model", "output_style", "permissionMode", "plugins", "product_feedback_disabled", "skills", "slash_commands", "terminal_slash_commands", "tools"]);
        else if (event.subtype === "thinking_tokens") keys(event, [...common, "subtype", "estimated_tokens", "estimated_tokens_delta"]);
        else throw Error("Unsupported retained Claude system event.");
        break;
      case "assistant": {
        keys(event, [...common, "timestamp", "parent_tool_use_id", "request_id", "message", "api_error_code", "error", "is_api_error_message", "wire_tool_inputs", "tool_use_meta", "wire_ingest_context"], [...common, "timestamp", "parent_tool_use_id", "request_id", "message"]);
        const message = object(event.message);
        keys(message, ["container", "content", "context_management", "diagnostics", "id", "input_transformations", "model", "role", "stop_details", "stop_reason", "stop_sequence", "type", "usage"], ["container", "content", "context_management", "diagnostics", "id", "model", "role", "stop_details", "stop_reason", "stop_sequence", "type", "usage"]);
        strings(message, ["id", "model", "role"]); content(message.content); object(message.usage); break;
      }
      case "user": {
        keys(event, [...common, "timestamp", "parent_tool_use_id", "message", "tool_use_result", "tool_result_meta"], [...common, "timestamp", "parent_tool_use_id", "message"]);
        const message = object(event.message); keys(message, ["content", "role"]); strings(message, ["role"]); content(message.content); break;
      }
      case "result":
        keys(event, [...common, "subtype", "api_error_code", "api_error_status", "duration_api_ms", "duration_ms", "errors", "fast_mode_disabled_reason", "fast_mode_state", "first_content_frame_ms", "is_error", "modelUsage", "num_turns", "permission_denials", "queued_turn_count", "result", "result_index", "stop_reason", "subagent_stats", "terminal_reason", "time_to_request_ms", "total_cost_usd", "ttft_ms", "ttft_stream_ms", "usage"], [...common, "subtype", "duration_api_ms", "duration_ms", "fast_mode_disabled_reason", "fast_mode_state", "is_error", "modelUsage", "num_turns", "permission_denials", "queued_turn_count", "result_index", "stop_reason", "subagent_stats", "terminal_reason", "total_cost_usd", "usage"]);
        if (!["success", "error_during_execution"].includes(event.subtype)) throw Error("Unsupported retained Claude result.");
        object(event.usage); object(event.modelUsage); break;
      default: throw Error("Unsupported retained Claude event.");
    }
  }
}
