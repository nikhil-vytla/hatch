import { existsSync } from "node:fs";
import { evaluate, GatewayError } from "../experience-prototypes/scripts/local-model";
import { readRecord, writeRecord } from "../experience-prototypes/scripts/records";
import { cases } from "./cases";
import { ENGINE_VERSION, CONTOURS, blankScore, settingsFromAnswers, globalRequest, phraseRequest, makeCandidates, applyCandidate, validateScore, type Score } from "./engine";
const path = new URL("./music-v2.jsonl", import.meta.url).pathname;
const document: any = existsSync(path) ? readRecord(path) : {
  manifest: { experiment: "music-v2", engine: ENGINE_VERSION, created: new Date().toISOString(), status: "recording", model: "typesafe-ai/jev", source: "Live gateway requests using authorized local credentials", protocol: "14 authored briefs; 8 preserved original inputs and 6 additional contour-specific briefs, one seed each, one global call and four sequential contextual phrase calls. No audio input, no human listening evaluation.", candidate_policy: "Six procedural candidates per phrase. Jev chooses from full event descriptions. Every choice conditions on selected phrase history. Independent global choices share one request. No quality-based retries.", retry_policy: "Gateway retries only transient HTTP/network failures. A resumed run keeps completed decisions. Invalid answers and permanent errors remain errors.", planned_cases: cases, original_source: "../results/music.jsonl, original records retained unchanged" },
  result: { rows: [], provider_history: [], human_preference: null, note: "These are authored examples and mechanical checks. No listener preference, scene-fit quality or superiority claim is supported.", availability: { planned: cases.length, completed: 0, unavailable: 0 } },
};
function save() {
  document.result.availability = { planned: cases.length, completed: document.result.rows.filter((r: any) => r.status === "complete").length, unavailable: document.result.rows.filter((r: any) => r.error).length };
  document.manifest.updated = new Date().toISOString();
  writeRecord(path, document);
}
function comparator(score: Score, mode: "rule" | "random", requested?: string) {
  let s = blankScore(score.brief, score.settings, score.seed);
  s.phrases = score.phrases.map(p => ({ ...p, source: "procedural", decision: undefined, candidateId: "", locked: false }));
  for (let i = 0; i < 4; i++) {
    const pool = makeCandidates(s, i);
    const ix = mode === "rule" ? requested ? CONTOURS.indexOf(requested as any) : [2, 1, 5, 4][i] : ((s.seed * 1664525 + (i + 1) * 1013904223) >>> 0) % pool.length;
    s = applyCandidate(s, i, pool[Math.max(0, ix)], "procedural");
  }
  s.provenance.kind = mode === "rule" ? "Declared rule baseline: explicit requested contour, else arch/falling/syncopated/breath." : "Seeded uniform-index baseline over six procedural candidates. Not a listener evaluation.";
  return s;
}
async function call(row: any, stage: string, request: any) {
  const existing = row.calls.find((c: any) => c.stage === stage && c.result);
  if (existing) return existing.result;
  const last = row.calls.filter((c: any) => c.stage === stage).at(-1);
  if (last?.error && !last.retryable && JSON.stringify(last.request) === JSON.stringify(request)) throw new Error(`Recorded permanent failure at ${stage}; not retried.`);
  const call: any = { stage, request, started: new Date().toISOString(), attempts: [] }; row.calls.push(call); save();
  try {
    call.result = await evaluate(request, { deadlineMs: 120000, onAttempt: a => { call.attempts.push(a); save(); } });
    call.finished = new Date().toISOString(); save();
    console.log(`${row.id} ${stage} complete, ${call.result.latency_ms} ms`);
    return call.result;
  } catch (error) {
    call.finished = new Date().toISOString();
    call.error = error instanceof Error ? error.message : String(error);
    call.status = error instanceof GatewayError ? error.status : "unknown";
    call.retryable = error instanceof GatewayError && [408, 429, 500, 502, 503, 504].includes(error.status) && !/invalid (answer|JSON|confidence|probabilities)/i.test(error.message);
    document.result.provider_history.push({ id: row.id, stage, error: call.error, status: call.status, attempts: call.attempts, at: call.finished }); save(); throw error;
  }
}
for (const spec of cases) {
  let row = document.result.rows.find((r: any) => r.id === spec.id);
  if (row?.status === "complete") continue;
  if (!row) { row = { ...spec, status: "pending", calls: [] }; document.result.rows.push(row); }
  delete row.error; row.status = "recording"; save();
  try {
    const global = await call(row, "global", globalRequest(spec.brief));
    let score = blankScore(spec.brief, settingsFromAnswers(global.answers), spec.seed);
    if (spec.requestedContour) score.phrases = score.phrases.map(p => ({ ...p, direction: `${p.direction} Explicit request: ${spec.requestedContour} contour in this phrase.` }));
    score.provenance = { kind: "Jev selected global settings and four contextual phrases from procedural candidates.", decisions: [{ stage: "global", ...global }], edits: [] };
    for (let index = 0; index < 4; index++) {
      const candidates = makeCandidates(score, index), request = phraseRequest(score, index, candidates);
      const response = await call(row, `phrase-${index + 1}`, request);
      const selected = candidates.find(c => c.id === response.answers.phrase.value);
      if (!selected) throw new Error("Selected candidate missing from the frozen pool.");
      score = applyCandidate(score, index, selected, "jev", { stage: `phrase-${index + 1}`, scoreVersion: score.version, candidateId: selected.id, ...response });
      row.score = score; save();
    }
    row.score = score;
    row.mechanical = { errors: validateScore(score), event_count: score.events.length, contours: score.phrases.map(p => p.contour), explicit_contour_matches: spec.requestedContour ? score.phrases.filter(p => p.contour === spec.requestedContour).length : null };
    row.baselines = { rule: comparator(score, "rule", spec.requestedContour), random: comparator(score, "random") };
    row.status = "complete"; save();
  } catch (error) {
    row.error = error instanceof Error ? error.message : String(error); row.status = "unavailable"; save();
    console.log(`${row.id} unavailable: ${row.error}`);
  }
}
document.manifest.status = document.result.availability.completed === cases.length ? "complete" : "partial";
const completed = document.result.rows.filter((r: any) => r.status === "complete");
document.result.metrics = {
  completed: completed.length, planned: cases.length,
  validated_scores: completed.filter((r: any) => r.mechanical.errors.length === 0).length,
  selected_contours: Object.fromEntries(CONTOURS.map(c => [c, completed.reduce((sum: number, r: any) => sum + r.score.phrases.filter((p: any) => p.contour === c).length, 0)])),
  explicit_contour_matches: completed.filter((r: any) => r.requestedContour).reduce((sum: number, r: any) => sum + r.mechanical.explicit_contour_matches, 0),
  explicit_contour_phrases: completed.filter((r: any) => r.requestedContour).length * 4,
  human_preference: null,
};
save(); console.log(JSON.stringify(document.result.metrics, null, 2));
