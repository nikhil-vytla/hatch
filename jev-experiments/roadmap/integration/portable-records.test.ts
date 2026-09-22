import { test, expect } from "bun:test";
import { derivePortableRecord, decodePortableRecord, digest } from "./portable-records";
const sourcePath = "/example/fixture/sum.ts", uri = "record://fixture/sum.ts";
const transcript = () => [
 { type: "thread.started", thread_id: "authored-thread" },
 { type: "turn.started" },
 { type: "item.completed", item: {
   id: "call-1", type: "mcp_tool_call", status: "completed", server: "jev", tool: "route_task",
   arguments: { task: { id: "authored", context: `File ${sourcePath}\nexport const sum = (a,b) => a+b;` } },
   error: null,
   result: { structuredContent: { status: "ok", attempts: [{ cost: 0.001, model: "authored-model" }], outcome: { artifact: { kind: "structured", value: { bug: null } } } } },
 } },
 { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 3, cached_input_tokens: 4 } },
];
const raw = (value: unknown[]) => value.map((event) => JSON.stringify(event)).join("\n") + "\n";
function fixture() {
 const events = transcript(), before = events[2].item!.arguments.task.context;
 return { events, text: raw(events), edits: [{ record: 2, pointer: "/item/arguments/task/context", before, after: before.replace(sourcePath, uri), bindings: [{ source: sourcePath, target: uri }] }] };
}
test("explicit context spans preserve tool identity, code, structured results and accounting", () => {
 const { events, text, edits } = fixture();
 const derivative = derivePortableRecord(text, "transcript", digest(text), edits), record = decodePortableRecord(derivative, "transcript");
 expect(record.source.sha256).toBe(digest(text)); expect(record.source.bytes).toBe(Buffer.byteLength(text));
 expect(record.payload[2].item.arguments.task.context).toBe(edits[0].after);
 expect(record.payload[2].item.result).toEqual(events[2].item!.result); expect(record.payload[3]).toEqual(events[3]);
 expect(record.transformation.fields[0].originalSha256).toBe(digest(edits[0].before));
 expect(derivePortableRecord(text, "transcript", digest(text), edits)).toBe(derivative);
});
test("changed source bytes or field, missing pointer and unplanned mutation fail closed", () => {
 const { text, edits } = fixture();
 expect(() => derivePortableRecord(text + "\n", "transcript", digest(text), edits)).toThrow("bytes");
 expect(() => derivePortableRecord(text, "transcript", digest(text), [{ ...edits[0], before: "wrong" }])).toThrow("field");
 expect(() => derivePortableRecord(text, "transcript", digest(text), [{ ...edits[0], pointer: "/missing" }])).toThrow("field");
 expect(() => derivePortableRecord(text, "transcript", digest(text), [{ ...edits[0], after: edits[0].after + " modified code" }])).toThrow("reviewed field");
});
test("unknown client events, fields and derivative envelopes are rejected", () => {
 for (const events of [[{ type: "future.event" }], [{ type: "thread.started", thread_id: "a", unexpected: true }]]) {
  const text = raw(events); expect(() => derivePortableRecord(text, "transcript", digest(text), [])).toThrow();
 }
 const { text, edits } = fixture(), record = JSON.parse(derivePortableRecord(text, "transcript", digest(text), edits));
 expect(() => decodePortableRecord(JSON.stringify({ ...record, unknownEnvelope: true }))).toThrow("envelope");
 record.payload[3].usage.output_tokens = 999;
 expect(() => decodePortableRecord(JSON.stringify(record))).toThrow("hash mismatch");
});
test("summary outcomes stay exact and incomplete cancellation transcripts remain incomplete", () => {
 const summary = { harness: "codex", command: ["codex", "exec"], evidenceGate: { passed: false, condition: "authored" }, exitCode: 1, timedOut: true, elapsedSeconds: 0.25 };
 const text = JSON.stringify(summary) + "\n";
 expect(decodePortableRecord(derivePortableRecord(text, "summary", digest(text), [])).payload).toEqual(summary);
 const events = [{ type: "turn.started" }], incomplete = raw(events);
 expect(decodePortableRecord(derivePortableRecord(incomplete, "transcript", digest(incomplete), [])).payload).toEqual(events);
});
test("location aliases cannot collapse distinct source identities", () => {
 const events = [{ type: "item.completed", item: { id: "a", type: "agent_message", text: "/example/a /example/b" } }];
 const text = raw(events);
 expect(() => derivePortableRecord(text, "transcript", digest(text), [{ record: 0, pointer: "/item/text", before: "/example/a /example/b", after: "record://fixture/shared record://fixture/shared", bindings: [{ source: "/example/a", target: "record://fixture/shared" }, { source: "/example/b", target: "record://fixture/shared" }] }])).toThrow();
});
