import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { decodePortableRecord, digest } from "./portable-records";
/** Relink archived records without recomputing historical gates or measurements. */
export function buildPortableIndex(root: string) {
 const path = resolve(root, "index.json"), raw = readFileSync(path, "utf8"), index = JSON.parse(raw);
 if (!Array.isArray(index.runs)) throw Error("Invalid evidence index.");
 const named = new Set(index.runs.map((run: any) => run.run));
 if (named.size !== index.runs.length) throw Error("Duplicate retained run identity.");
 for (const folder of readdirSync(root, { withFileTypes: true })) {
  if (folder.isDirectory() && !named.has(folder.name) && ["summary.json", "summary.portable.json"].some((file) => existsSync(resolve(root, folder.name, file)))) throw Error("Unindexed condition requires separate review; archive relinking does not grade new runs.");
 }
 const originalIndexSha256 = index.retained_record_index?.originalIndexSha256 ?? digest(raw);
 if (!/^[a-f0-9]{64}$/.test(originalIndexSha256)) throw Error("Invalid index lineage.");
 let converted = 0;
 for (const run of index.runs) {
  if (!["codex", "opencode", "claude"].includes(run.harness)) throw Error("Unsupported retained harness.");
  if (typeof run.run !== "string" || !/^[a-z0-9-]+$/.test(run.run)) throw Error("Invalid retained run.");
  const retainedRecords: Record<string, any> = { ...run.retainedRecords };
  for (const [field, kind, originalFile, portableFile, linked] of [
   ["summary", "summary", "summary.json", "summary.portable.json", true],
   ["transcript", "transcript", "stdout.jsonl", "stdout.portable.json", true],
   ["testsBefore", "text", "tests-before.txt", "tests-before.portable.json", false],
   ["testsAfter", "text", "tests-after.txt", "tests-after.portable.json", false],
  ] as const) {
   const originalName = `${run.run}/${originalFile}`, name = `${run.run}/${portableFile}`;
   if (linked && ![originalName, name].includes(run[field])) throw Error("Unexpected retained index link.");
   if (!existsSync(resolve(root, name))) {
    if (retainedRecords[field] || (linked && (run[field] !== originalName || run.harness === "codex" || !existsSync(resolve(root, originalName))))) throw Error("Missing retained derivative.");
    continue;
   }
   if (existsSync(resolve(root, originalName))) throw Error("Ambiguous original and derivative tree; archival migration is incomplete.");
   const text = readFileSync(resolve(root, name), "utf8"), record = decodePortableRecord(text, kind);
   if (record.harness !== run.harness) throw Error("Retained harness and historical index disagree.");
   if (field === "summary") {
    const summary = record.payload;
    if (!isDeepStrictEqual(summary.evidenceGate, run.gate) || summary.harness !== run.harness || summary.cliVersion !== run.version || !isDeepStrictEqual(summary.hostModel, run.hostModel) || summary.delegationOccurred !== run.delegationOccurred || summary.firstAuditTime !== run.firstAuditTime || summary.auditChronologyOrder !== run.order) throw Error("Retained summary and historical index disagree.");
   }
   const link = { format: record.format, originalFile: originalName, originalSha256: record.source.sha256, derivativeSha256: digest(text), payloadSha256: record.payloadSha256 };
   if (retainedRecords[field] && !isDeepStrictEqual(retainedRecords[field], link)) throw Error("Retained index source identity changed.");
   if (linked) run[field] = name;
   retainedRecords[field] = link;
  }
  if (Object.keys(retainedRecords).length) { run.retainedRecords = retainedRecords; converted++; }
 }
 if (!converted) throw Error("No retained records in index.");
 index.retained_record_index = { ...index.retained_record_index, format: "jev-portable-retained-index-v1", originalIndexSha256,
  note: "Historical outcomes are retained without regrading. Retained-record links identify portable derivatives; original bytes are identified by lineage hashes and are not present in this tree." };
 writeFileSync(path, JSON.stringify(index, null, 2) + "\n");
 return { runs: index.runs.length, converted };
}
if (import.meta.main) console.log(JSON.stringify(buildPortableIndex(resolve(import.meta.dir, "evidence"))));
