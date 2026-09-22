import { validateClientTranscript } from "./portable-client-schemas";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
type Value = Record<string, any>;
export type Kind = "summary" | "transcript" | "text";
export type Harness = "codex" | "opencode" | "claude";
export type FieldEdit = { record: number; pointer: string; before: string; after: string; bindings: { source: string; target: string }[] };
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): Value => { if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Expected a record object."); return value as Value; };
const exactKeys = (value: Value, allowed: readonly string[], required: readonly string[] = allowed) => {
 if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) throw Error("Unknown or incomplete retained-record envelope.");
};
const summaryKeys = ["additionalTestsWritten","analysisFileWritten","annotationProvenance","auditChronologyOrder","baselineTestsExitCode","boundaryExplanations","cancelledToolResult","cliVersion","clientTerminalReason","command","contextComplete","delegationOccurred","directory","elapsedSeconds","evidenceBoundary","evidenceGate","exitCode","expectedTestsFail","firstAuditTime","harness","hostExitedBeforeScheduledReply","hostModel","independentTestsExitCode","invokedBeforeInterrupt","lateSuccessApplied","mcpConfigUnchanged","mcpDiscovered","noDestinationAttempts","observedBoundaryStatuses","patchedBug","purpose","routerConfigUnchanged","serverSawCancellation","serverSawDisconnect","sourceUnchanged","timedOut","toolCalls","toolResults","usableDelegatedArtifacts"];
function validatePayload(kind: Kind, payload: unknown, harness: Harness) {
 if (kind === "text") { const record = object(payload); exactKeys(record, ["text"]); if (typeof record.text !== "string") throw Error("Expected retained text."); return; }
 if (kind === "summary") {
  const record = object(payload); exactKeys(record, summaryKeys, ["harness", "command", "evidenceGate"]);
  if (record.harness !== harness || !Array.isArray(record.command) || !record.command.every((s: unknown) => typeof s === "string")) throw Error("Unsupported retained summary.");
  object(record.evidenceGate); return;
 }
 if (harness !== "codex") { validateClientTranscript(harness, payload); return; }
 if (!Array.isArray(payload)) throw Error("Expected transcript event array.");
 for (const value of payload) {
  const event = object(value);
  switch (event.type) {
   case "thread.started": exactKeys(event, ["type", "thread_id"]); if (typeof event.thread_id !== "string") throw Error("Invalid thread identity."); break;
   case "turn.started": exactKeys(event, ["type"]); break;
   case "turn.completed": {
    exactKeys(event, ["type", "usage"]); const usage = object(event.usage);
    exactKeys(usage, ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"], ["input_tokens", "output_tokens"]);
    if (!Object.values(usage).every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) throw Error("Invalid retained accounting."); break;
   }
   case "item.started": case "item.completed": {
    exactKeys(event, ["type", "item"]); const item = object(event.item);
    const fields: Record<string, string[]> = {
     agent_message: ["id", "type", "text"],
     command_execution: ["id", "type", "status", "command", "aggregated_output", "exit_code"],
     mcp_tool_call: ["id", "type", "status", "arguments", "error", "result", "server", "tool"],
     file_change: ["id", "type", "status", "changes"],
    };
    if (!fields[item.type]) throw Error("Unsupported retained Codex item.");
    exactKeys(item, fields[item.type]);
    if (typeof item.id !== "string") throw Error("Invalid retained item identity.");
    if (item.type === "file_change") {
     if (!Array.isArray(item.changes)) throw Error("Invalid retained file changes.");
     item.changes.forEach((change: unknown) => exactKeys(object(change), ["path", "kind"]));
    }
    break;
   }
   default: throw Error("Unsupported retained Codex event.");
  }
 }
}
function field(payload: any, kind: Kind, record: number, pointer: string) {
 if (!Number.isSafeInteger(record) || record < 0 || (kind !== "transcript" && record !== 0) || !pointer.startsWith("/") || /~(?![01])/u.test(pointer)) throw Error("Invalid retained field pointer.");
 let parent = kind !== "transcript" ? payload : payload[record];
 const segments = pointer.slice(1).split("/").map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
 const key = segments.pop()!;
 for (const segment of segments) { if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, segment)) throw Error("Missing retained field."); parent = parent[segment]; }
 if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, key) || typeof parent[key] !== "string") throw Error("Expected retained string field.");
 return { parent, key };
}
const notice = "Portable retained-record derivative. Only explicitly listed physical-location spans differ; event order, task content outside those spans, returned artifacts, outcomes and accounting are retained. Original field hashes describe the historical input, not these derivative bytes. Location URIs are display references, not executable commands.";
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function decodePortableRecord(text: string, expectedKind?: Kind) {
 const value = object(JSON.parse(text));
 exactKeys(value, ["format", "harness", "kind", "source", "transformation", "payloadSha256", "payload"]);
 if (value.format !== "jev-portable-retained-record-v1" || !["codex", "opencode", "claude"].includes(value.harness) || !["summary", "transcript", "text"].includes(value.kind) || (expectedKind && expectedKind !== value.kind)) throw Error("Unsupported portable record format.");
 const source = object(value.source); exactKeys(source, ["sha256", "bytes", "format", "recordCount"]);
 if (!hash(source.sha256) || !Number.isSafeInteger(source.bytes) || source.bytes < 0 || source.format !== (value.kind === "summary" ? "json" : value.kind === "text" ? "utf8" : `${value.harness}-jsonl`) || source.recordCount !== (value.kind !== "transcript" ? 1 : value.payload?.length)) throw Error("Invalid predecessor lineage.");
 validatePayload(value.kind, value.payload, value.harness);
 if (!hash(value.payloadSha256) || digest(JSON.stringify(value.payload)) !== value.payloadSha256) throw Error("Retained payload hash mismatch.");
 const transform = object(value.transformation); exactKeys(transform, ["id", "note", "fields"]);
 if (transform.id !== "jev-explicit-location-spans-v1" || transform.note !== notice || !Array.isArray(transform.fields)) throw Error("Unsupported retained transformation.");
 const locations = new Set<string>(); const uriSources = new Map<string, string>();
 for (const raw of transform.fields) {
  const edit = object(raw); exactKeys(edit, ["record", "pointer", "originalSha256", "derivativeSha256", "bindings"]);
  const identity = `${edit.record}:${edit.pointer}`;
  if (locations.has(identity) || !hash(edit.originalSha256) || !hash(edit.derivativeSha256) || !Array.isArray(edit.bindings) || !edit.bindings.length) throw Error("Invalid retained field lineage.");
  locations.add(identity); const target = field(value.payload, value.kind, edit.record, edit.pointer);
  if (digest(target.parent[target.key]) !== edit.derivativeSha256) throw Error("Retained field hash mismatch.");
  for (const rawBinding of edit.bindings) {
   const binding = object(rawBinding); exactKeys(binding, ["sourcePathSha256", "uri", "occurrences"]);
   if (!hash(binding.sourcePathSha256) || !/^record:\/\/[a-z0-9-]+\/[A-Za-z0-9_./%-]+$/.test(binding.uri) || !Number.isSafeInteger(binding.occurrences) || binding.occurrences < 1 || target.parent[target.key].split(binding.uri).length - 1 !== binding.occurrences) throw Error("Invalid retained location binding.");
   if (uriSources.has(binding.uri) && uriSources.get(binding.uri) !== binding.sourcePathSha256) throw Error("Location aliases collide.");
   uriSources.set(binding.uri, binding.sourcePathSha256);
  }
 }
 return value;
}
/** Apply a private, exact-field edit plan. No recursive or pattern-based replacement occurs. */
export function derivePortableRecord(raw: string, kind: Kind, expectedSourceSha256: string, edits: readonly FieldEdit[], harness: Harness = "codex") {
 if (digest(raw) !== expectedSourceSha256) throw Error("Predecessor bytes changed.");
 const payload = kind === "summary" ? JSON.parse(raw) : kind === "text" ? { text: raw } : raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
 validatePayload(kind, payload, harness);
 const fields = edits.map((edit) => {
  const selected = field(payload, kind, edit.record, edit.pointer);
  if (selected.parent[selected.key] !== edit.before) throw Error("Predecessor field changed.");
  let next = edit.before;
  const bindings = edit.bindings.map(({ source, target }) => {
   if (!source || !target || source === target || !source.startsWith("/") || source.includes("record://") || !next.includes(source)) throw Error("Invalid explicit location edit.");
   const occurrences = next.split(source).length - 1; next = next.split(source).join(target);
   return { sourcePathSha256: digest(source), uri: target, occurrences };
  });
  if (next !== edit.after || next === edit.before) throw Error("Explicit location edit does not match its reviewed field.");
  selected.parent[selected.key] = next;
  return { record: edit.record, pointer: edit.pointer, originalSha256: digest(edit.before), derivativeSha256: digest(next), bindings };
 });
 const envelope = { format: "jev-portable-retained-record-v1", harness, kind,
  source: { sha256: expectedSourceSha256, bytes: Buffer.byteLength(raw), format: kind === "summary" ? "json" : kind === "text" ? "utf8" : `${harness}-jsonl`, recordCount: kind !== "transcript" ? 1 : payload.length },
  transformation: { id: "jev-explicit-location-spans-v1", note: notice, fields }, payloadSha256: digest(JSON.stringify(payload)), payload };
 const serialized = JSON.stringify(envelope, null, 2) + "\n";
 if (!isDeepStrictEqual(decodePortableRecord(serialized, kind), envelope)) throw Error("Derivative serialization changed.");
 return serialized;
}
