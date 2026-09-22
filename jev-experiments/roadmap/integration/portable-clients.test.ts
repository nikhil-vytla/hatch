import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePortableRecord, decodePortableRecord, digest, type Harness } from "./portable-records";
import { buildPortableIndex } from "./portable-index";
import { preparePublicHarnessEvidence } from "../../capability-atlas-2026-09-22/publication-projection";
const physical = "/example/fixture/sum.ts", uri = "record://fixture/sum.ts";
const jsonl = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";
function events(harness: "opencode" | "claude"): any[] {
 if (harness === "opencode") return [
  { type: "step_start", timestamp: 1, sessionID: "authored-session", part: { type: "step-start", id: "part-1", messageID: "message-1", sessionID: "authored-session" } },
  { type: "tool_use", timestamp: 2, sessionID: "authored-session", part: { type: "tool", id: "part-2", messageID: "message-1", sessionID: "authored-session", callID: "call-1", tool: "jev_route_task", state: { status: "completed", input: { task: { context: physical } }, output: JSON.stringify({ status: "unavailable", unknown: null, attempts: [], cost: null }), metadata: { opaque: { futureValue: null } }, title: "authored task", time: { start: 1, end: 2 } } } },
  { type: "step_finish", timestamp: 3, sessionID: "authored-session", part: { type: "step-finish", id: "part-3", messageID: "message-1", sessionID: "authored-session", cost: 0.002, reason: "stop", tokens: { input: 12, output: 3, cache: { read: 4, write: 0 } } } },
 ];
 return [
  { type: "assistant", session_id: "authored-session", uuid: "event-1", timestamp: "2026-01-01T00:00:00Z", parent_tool_use_id: null, request_id: "request-1", message: { container: null, content: [{ type: "thinking", thinking: "authored reasoning", signature: "authored-signature" }, { type: "tool_use", id: "call-1", name: "mcp__jev__route_task", input: { task: { context: physical } }, caller: { type: "direct" } }], context_management: null, diagnostics: { unknown: null }, id: "message-1", model: "authored-model", role: "assistant", stop_details: null, stop_reason: null, stop_sequence: null, type: "message", usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 4 } } },
  { type: "user", session_id: "authored-session", uuid: "event-2", timestamp: "2026-01-01T00:00:01Z", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: [{ type: "text", text: JSON.stringify({ status: "unavailable", unknown: null, attempts: [], cost: null }) }], is_error: false }] }, tool_use_result: { structuredContent: { unknown: null } } },
 ];
}
function edit(harness: "opencode" | "claude") {
 return { record: harness === "opencode" ? 1 : 0, pointer: harness === "opencode" ? "/part/state/input/task/context" : "/message/content/1/input/task/context", before: physical, after: uri, bindings: [{ source: physical, target: uri }] };
}
for (const harness of ["opencode", "claude"] as const) {
 test(`${harness} location derivative retains identities, unknowns, task results and accounting`, () => {
  const original = events(harness), raw = jsonl(original), e = edit(harness);
  const text = derivePortableRecord(raw, "transcript", digest(raw), [e], harness), record = decodePortableRecord(text, "transcript");
  const expected = structuredClone(original);
  if (harness === "opencode") expected[1].part.state.input.task.context = uri; else expected[0].message.content[1].input.task.context = uri;
  expect(record.payload).toEqual(expected); expect(record.harness).toBe(harness);
  expect(record.source.format).toBe(`${harness}-jsonl`); expect(record.source.recordCount).toBe(original.length);
  expect(record.source.sha256).toBe(digest(raw)); expect(record.source.bytes).toBe(Buffer.byteLength(raw));
  expect(derivePortableRecord(raw, "transcript", digest(raw), [e], harness)).toBe(text);
  expect(record.transformation.fields[0].originalSha256).toBe(digest(physical));
 });
 test(`${harness} changed source, unknown host envelope and unplanned task edits fail closed`, () => {
  const original = events(harness), raw = jsonl(original), e = edit(harness);
  expect(() => derivePortableRecord(raw + "\n", "transcript", digest(raw), [e], harness)).toThrow("bytes");
  expect(() => derivePortableRecord(raw, "transcript", digest(raw), [{ ...e, after: uri + " altered task" }], harness)).toThrow("reviewed field");
  const unknown = jsonl([{ ...original[0], unknownEnvelope: true }]);
  expect(() => derivePortableRecord(unknown, "transcript", digest(unknown), [], harness)).toThrow("fields");
  const unknownEvent = jsonl([{ ...original[0], type: "future.event" }]);
  expect(() => derivePortableRecord(unknownEvent, "transcript", digest(unknownEvent), [], harness)).toThrow();
  const record = JSON.parse(derivePortableRecord(raw, "transcript", digest(raw), [e], harness));
  record.source.format = harness === "claude" ? "opencode-jsonl" : "claude-jsonl";
  expect(() => decodePortableRecord(JSON.stringify(record))).toThrow("lineage");
 });
}
test("client nested envelope validation and text-log locations are explicit and lossless", () => {
 const original = events("claude"); original[0].message.content[0].type = "future-reasoning";
 const bad = jsonl(original); expect(() => derivePortableRecord(bad, "transcript", digest(bad), [], "claude")).toThrow("content type");
 const raw = `bun test\r\n${physical}: unchanged failure — 0 pass, 2 fail [12.34ms]\n`;
 const after = raw.replace(physical, uri), e = { record: 0, pointer: "/text", before: raw, after, bindings: [{ source: physical, target: uri }] };
 const result = derivePortableRecord(raw, "text", digest(raw), [e], "claude"), record = decodePortableRecord(result, "text");
 expect(record.payload).toEqual({ text: after }); expect(record.source.bytes).toBe(Buffer.byteLength(raw)); expect(record.source.format).toBe("utf8");
 expect(record.source.recordCount).toBe(1); expect(record.payload.text.replace(uri,physical)).toBe(raw);
 expect(() => decodePortableRecord(result,"transcript")).toThrow("format");
 record.payload.text += "changed"; expect(() => decodePortableRecord(JSON.stringify(record))).toThrow("hash mismatch");
 expect(() => derivePortableRecord(raw,"text",digest(raw),[{...e,record:1}],"claude")).toThrow("pointer");
});
function fixture() {
 const root = mkdtempSync(join(tmpdir(), "portable-clients-")), lab = join(root,"lab"), evidence = join(lab,"roadmap/integration/evidence");
 mkdirSync(evidence,{recursive:true});const runs:any[]=[];
 for (const [offset,harness] of (["opencode","claude"] as const).entries()) {
  const folder=join(evidence,harness);mkdirSync(folder);
  const summary={harness,command:[harness,"run"],evidenceGate:{passed:false,condition:"authored negative",unknown:null},cliVersion:"authored",hostModel:{configured:"authored-model",identityBasis:"fixture"},delegationOccurred:false,firstAuditTime:"2026-01-01T00:00:00Z",auditChronologyOrder:offset+1,elapsedSeconds:0.125,exitCode:1,timedOut:false};
  const raw=JSON.stringify(summary)+"\n";
  writeFileSync(join(folder,"summary.portable.json"),derivePortableRecord(raw,"summary",digest(raw),[],harness));
  const transcript=jsonl(events(harness));
  // One untouched transcript remains raw; mixed trees do not invent a migration.
  if(harness==="opencode")writeFileSync(join(folder,"stdout.portable.json"),derivePortableRecord(transcript,"transcript",digest(transcript),[edit(harness)],harness));
  else writeFileSync(join(folder,"stdout.jsonl"),transcript);
  writeFileSync(join(folder,"mcp-audit.jsonl"),JSON.stringify({event:"tools/list",time:summary.firstAuditTime})+"\n");
  if(harness==="opencode")for(const file of ["tests-before","tests-after"]){
   const text=`${physical}: 0 pass, 2 fail\n`,after=text.replace(physical,uri);
   writeFileSync(join(folder,`${file}.portable.json`),derivePortableRecord(text,"text",digest(text),[{record:0,pointer:"/text",before:text,after,bindings:[{source:physical,target:uri}]}],harness));
  }
  runs.push({order:offset+1,run:harness,harness,version:summary.cliVersion,hostModel:summary.hostModel,delegationOccurred:false,firstAuditTime:summary.firstAuditTime,gate:summary.evidenceGate,summary:`${harness}/summary.json`,transcript:`${harness}/stdout.jsonl`,audit:`${harness}/mcp-audit.jsonl`,unknownHistoricalField:null});
 }
 writeFileSync(join(evidence,"index.json"),JSON.stringify({orderBasis:"authored",runs})+"\n");
 return{root,lab,evidence};
}
test("mixed client index preserves history and publishes existing text downloads with lineage",()=>{
 const f=fixture();try{
  expect(buildPortableIndex(f.evidence)).toEqual({runs:2,converted:2});
  const raw=readFileSync(join(f.evidence,"index.json"),"utf8"),index=JSON.parse(raw);
  expect(index.runs[0].transcript).toBe("opencode/stdout.portable.json");expect(index.runs[1].transcript).toBe("claude/stdout.jsonl");
  expect(index.runs.every((r:any)=>r.gate.passed===false&&r.unknownHistoricalField===null)).toBe(true);
  expect(index.runs[0].retainedRecords.testsBefore.originalFile).toBe("opencode/tests-before.txt");
  expect(index.runs[0].retainedRecords.testsAfter.originalFile).toBe("opencode/tests-after.txt");
  buildPortableIndex(f.evidence);expect(readFileSync(join(f.evidence,"index.json"),"utf8")).toBe(raw);
  const dest=join(f.root,"public");preparePublicHarnessEvidence(f.lab,dest);
  expect(readFileSync(join(dest,"opencode/tests-after.txt"),"utf8")).toBe(`${uri}: 0 pass, 2 fail\n`);
  expect(existsSync(join(dest,"opencode/tests-before.txt"))).toBe(false);
  const pub=JSON.parse(readFileSync(join(dest,"index.json"),"utf8"));
  expect(pub.runs[0].summary).toBe("opencode/summary.json");expect(pub.runs[1].transcript).toBe("claude/stdout.jsonl");
  expect(pub.publication_projection.files.find((p:any)=>p.path==="opencode/tests-after.txt").sourcePath).toBe("opencode/tests-after.portable.json");
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test("text-log ambiguity and forged lineage reject publication before any output",()=>{
 const f=fixture();try{
  const path=join(f.evidence,"opencode/tests-after.txt");writeFileSync(path,"original");
  expect(()=>buildPortableIndex(f.evidence)).toThrow("Ambiguous");unlinkSync(path);buildPortableIndex(f.evidence);
  const index=JSON.parse(readFileSync(join(f.evidence,"index.json"),"utf8"));index.runs[0].retainedRecords.testsAfter.originalSha256="0".repeat(64);writeFileSync(join(f.evidence,"index.json"),JSON.stringify(index));
  const dest=join(f.root,"rejected");expect(()=>preparePublicHarnessEvidence(f.lab,dest)).toThrow("lineage mismatch");expect(existsSync(dest)).toBe(false);
  expect(()=>buildPortableIndex(f.evidence)).toThrow("source identity");
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test("missing derivative and altered historical gate do not silently relink",()=>{
 const f=fixture();try{
  buildPortableIndex(f.evidence);const path=join(f.evidence,"opencode/tests-before.portable.json"),saved=readFileSync(path);unlinkSync(path);
  expect(()=>buildPortableIndex(f.evidence)).toThrow("Missing retained derivative");writeFileSync(path,saved);
  const ip=join(f.evidence,"index.json"),index=JSON.parse(readFileSync(ip,"utf8"));index.runs[0].gate.passed=true;writeFileSync(ip,JSON.stringify(index));
  expect(()=>buildPortableIndex(f.evidence)).toThrow("historical index disagree");
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
test("a derivative from the wrong client cannot satisfy another client's index",()=>{
 const f=fixture();try{
  const path=join(f.evidence,"opencode/stdout.portable.json"),raw=jsonl(events("claude"));writeFileSync(path,derivePortableRecord(raw,"transcript",digest(raw),[edit("claude")],"claude"));
  expect(()=>buildPortableIndex(f.evidence)).toThrow("harness");
 }finally{rmSync(f.root,{recursive:true,force:true});}
});
