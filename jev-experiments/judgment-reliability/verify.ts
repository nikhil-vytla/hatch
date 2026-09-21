import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEvidence, summarize } from "./analyze";
import { tasks, encodedQuestions, POLICY_STATE, hash } from "./protocol";
import { analysisMetadata } from "./clustering";
const here = dirname(fileURLToPath(import.meta.url)), evidence = loadEvidence(), { pairs, events, records, manifest } = evidence;
const expected = new Map(tasks(pairs).map(t => [t.id, t])), sources = new Map(pairs.map(p => [p.pair_id, p]));
let verifiedQuestions = 0, verifiedBatches = 0, rawAgreement = 0;
for (const r of records.values()) {
  const t = expected.get(r.id); if (!t) throw new Error(`Unplanned completion: ${r.id}`);
  const qs = encodedQuestions(sources.get(t.pair_id)!, t);
  if (hash(JSON.stringify(qs)) !== r.request_sha256) throw new Error(`Changed request: ${r.id}`);
  for (const [name, q] of Object.entries(qs)) { if (hash(JSON.stringify(q)) !== r.question_hashes[name]) throw new Error(`Changed question: ${r.id}/${name}`); verifiedQuestions++; }
  if (Object.keys(r.answers).sort().join() !== Object.keys(qs).sort().join()) throw new Error(`Answer coverage mismatch: ${r.id}`);
}
for (const e of events.filter(e => e.event === "batch_request")) {
  const questions = Object.fromEntries(e.mapping.map((m: any) => { const q = encodedQuestions(sources.get(m.task.pair_id)!, m.task)[m.name]; if (hash(JSON.stringify(q)) !== m.question_sha256) throw new Error(`Changed mapped question ${m.task.id}`); return [m.wire_id, q]; }));
  const wire = { state: POLICY_STATE, questions };
  if (hash(JSON.stringify(wire)) !== e.wire_sha256 || Buffer.byteLength(JSON.stringify(wire)) !== e.bytes) throw new Error(`Wire reconstruction failed ${e.batch_id}`);
  if (e.bytes > manifest.max_batch_bytes || e.mapping.length > manifest.max_batch_questions) throw new Error(`Packing bound exceeded ${e.batch_id}`);
  verifiedBatches++;
  const accepted = events.find(r => r.event === "batch_completed" && r.batch_id === e.batch_id && r.answers);
  if (accepted) for (const m of e.mapping) { const record = records.get(m.task.id); if (!record) continue; if (JSON.stringify(accepted.answers[m.wire_id]) !== JSON.stringify(record.answers[m.name])) throw new Error(`Raw outcome changed ${m.task.id}/${m.name}`); rawAgreement++; }
}
const { result } = summarize(evidence);
if (rawAgreement !== result.analysis.evidence_coverage.raw_matched_questions) throw new Error("Raw evidence coverage mismatch");
for (const pass of result.metrics.per_repeat) {
  if (pass.pairwise.official_correct + pass.pairwise.official_incorrect + pass.pairwise.official_ties !== 620) throw new Error("Official denominator mismatch");
  if (pass.shared.official_correct + pass.shared.official_incorrect + pass.shared.official_ties !== 620) throw new Error("Shared denominator mismatch");
}
const analysis = analysisMetadata(pairs, manifest.source_questions);
const report = { checked_at: new Date().toISOString(), complete: records.size === 7440, cases: pairs.length, source_clusters: analysis.source_clusters, analysis_version: analysis.version, frozen_protocol_source_questions: analysis.frozen_protocol_source_questions, distinct_question_texts: analysis.distinct_question_texts, completed_evaluations: records.size, planned_evaluations: 7440, verified_questions: verifiedQuestions, planned_questions: 14880, verified_wire_batches: verifiedBatches, raw_normalized_question_agreements: rawAgreement, evidence_coverage: result.analysis.evidence_coverage, immutable_successes: true, source_sha256: manifest.cases_sha256, protocol_sha256: manifest.protocol_sha256 };
writeFileSync(resolve(here, "verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
if (process.argv.includes("--complete") && !report.complete) throw new Error("Full study is not complete");
