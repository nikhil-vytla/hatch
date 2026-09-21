import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_COMMIT, MODELS, PROTOCOL, hash, payload, tasks, encodedQuestions, POLICY_STATE, type Pair } from "./protocol";
import { analysisMetadata } from "./clustering";
const here = dirname(fileURLToPath(import.meta.url));
const prior = JSON.parse(readFileSync(resolve(here, "../ifeval-review/content-audit/audit.json"), "utf8"));
const findings: any[] = Object.values(prior).flatMap((v: any) => Array.isArray(v) ? v : []).filter((v: any) => v?.dataset === "judge");
const sourceFiles: any[] = [], pairs: Pair[] = [];
for (const model of MODELS) {
  const path = `data/dataset=judgebench,response_model=${model}.jsonl`;
  const raw = readFileSync(resolve(here, `../.cache/upstream/ScalerLab/JudgeBench/${SOURCE_COMMIT}/${path}`));
  sourceFiles.push({ path, sha256: hash(raw), bytes: raw.length, url: `https://raw.githubusercontent.com/ScalerLab/JudgeBench/${SOURCE_COMMIT}/${path}` });
  pairs.push(...raw.toString().trim().split("\n").map(line => JSON.parse(line)));
}
const byId = new Map(pairs.map(p => [p.pair_id, p]));
const reviewedQuestion = new Map<string, any>();
for (const f of findings) for (const id of f.row_ids ?? []) { const p = byId.get(id.split("/")[0]); if (p) reviewedQuestion.set(hash(p.question), f); }
const patterns: [string, RegExp][] = [
  ["violence or self-harm", /\b(murder|suicid\w*|kill\w*|rape|torture|assault|sacrif\w*)\b/i],
  ["sexual or reproductive material", /\b(sex\w*|abortion|pregnan\w*|fetus|foetus|HIV|AIDS|porn\w*)\b/i],
  ["historical oppression or hateful language", /\b(slav\w*|racis\w*|nazi\w*|dehuman\w*|genocide|negro\w*|faggot\w*|nigger\w*)\b/i],
  ["drugs or other potentially sensitive material", /\b(cocaine|heroin|marijuana|methamphetamine|addict\w*|overdose)\b/i],
];
const enriched = pairs.map(p => {
  const previous = reviewedQuestion.get(hash(p.question));
  const flags = patterns.filter(([, re]) => re.test([p.question, p.response_A, p.response_B].join("\n"))).map(([name]) => name);
  return { ...p, content_hash: hash(JSON.stringify([p.question, p.response_A, p.response_B])), question_hash: hash(p.question), gate: previous ? { required: true, origin: "prior human content review matched by exact question hash", categories: previous.categories, note: previous.explanation } : flags.length ? { required: true, origin: "lexical triage, not exhaustive human review", categories: flags, note: "Academic benchmark text may discuss sensitive topics. Open the original text deliberately." } : { required: false, origin: "lexical triage only; not exhaustive human review", categories: [] } };
});
if (pairs.length !== 620 || byId.size !== 620 || new Set(pairs.map(p => `${p.source}/${p.original_id}`)).size !== 268) throw new Error("Source coverage changed");
const cases = enriched.map(p => JSON.stringify(p)).join("\n") + "\n";
const manifest = { ...PROTOCOL, frozen_at: "2026-09-20", source_commit: SOURCE_COMMIT, source_files: sourceFiles, protocol_sha256: hash(JSON.stringify({ protocol: PROTOCOL, policy_state: POLICY_STATE, encoder: encodedQuestions(pairs[0], tasks([pairs[0]])[0]) })), cases_sha256: hash(cases), gate_counts: { prior: enriched.filter(p => p.gate.origin.startsWith("prior")).length, lexical: enriched.filter(p => p.gate.required && !p.gate.origin.startsWith("prior")).length }, encoding: "self-contained evidence in every independent question", policy_state: POLICY_STATE, max_question_characters: Math.max(...tasks(pairs).flatMap(t => Object.values(encodedQuestions(byId.get(t.pair_id)!, t)).map((q: any) => q.instructions.length))), max_request_bytes: Math.max(...tasks(pairs).map(t => Buffer.byteLength(JSON.stringify(payload(byId.get(t.pair_id)!, t))))) };
for (const [name, content] of [["cases.jsonl", cases], ["manifest.json", JSON.stringify(manifest, null, 2) + "\n"]]) {
  const file = resolve(here, name); if (existsSync(file) && readFileSync(file, "utf8") !== content) throw new Error(`Immutable source changed: ${name}`); writeFileSync(file, content);
}
console.log(JSON.stringify({ pairs: pairs.length, frozen_protocol_source_questions: PROTOCOL.source_questions, analysis_source_clusters: analysisMetadata(pairs, PROTOCOL.source_questions).source_clusters, gates: manifest.gate_counts, max_request_bytes: manifest.max_request_bytes, protocol_sha256: manifest.protocol_sha256 }));
