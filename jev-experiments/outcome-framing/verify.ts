import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readRecord } from "../experience-prototypes/scripts/records";
import { initial, act, chooseCode, modelPolicies, features, type Policy } from "./tetris";
import { drawingCases, drawingMethods, drawingPayload, intensity, reference, drawingMetrics, SIZE } from "./drawing";
const here = import.meta.dir, hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
const events = readFileSync(resolve(here, "events.jsonl"), "utf8").trim().split("\n").map(s => JSON.parse(s));
const responses = new Map<string, any>();
for (const e of events) {
  if (e.kind === "request") assert(e.requestHash === hash(e.body), `Changed request ${e.id}`);
  if (e.kind === "response") {
    assert(!responses.has(e.id), `Duplicate response ${e.id}`);
    const request = events.find(r => r.kind === "request" && r.id === e.id);
    assert(request && request.requestHash === e.requestHash, `Missing request ${e.id}`);
    assert(Object.keys(request.body.questions).every(id => Object.hasOwn(e.output.answers, id)), `Incomplete batch ${e.id}`);
    responses.set(e.id, e);
  }
}
const t = readRecord(resolve(here, "tetris.jsonl")).result;
let transitions = 0, modelDecisions = 0;
assert(t.episodes.length === 35 && new Set(t.episodes.map((e: any) => e.id)).size === 35, "Episode coverage");
for (const episode of t.episodes) {
  let state = initial(episode.seed); state.pieces = state.pieces.slice(0, 34);
  for (const frame of episode.frames) {
    assert(hash(frame.before) === hash(state), `Before state differs: ${episode.id}/${transitions}`);
    const expected = modelPolicies.includes(episode.policy) ? responses.get(frame.requestId)?.output.answers[frame.questionId]?.value : chooseCode(state, episode.policy);
    assert(frame.value === expected, `Decision differs: ${episode.id}`);
    state = act(state, episode.policy, frame.value);
    assert(hash(frame.after) === hash(state), `After state differs: ${episode.id}`);
    transitions++; if (frame.requestId) modelDecisions++;
  }
  assert(hash(state) === hash(episode.state), `Terminal state differs: ${episode.id}`);
  assert(hash(features(state.board)) === hash(episode.final), `Board summary differs: ${episode.id}`);
  assert(state.status !== "playing" && episode.status === "complete", `Incomplete episode ${episode.id}`);
}
const d = readRecord(resolve(here, "drawing.jsonl")).result;
assert(d.maps.length === 33 && new Set(d.maps.map((m: any) => m.id)).size === 33, "Map coverage");
let pixels = 0;
for (const map of d.maps) {
  const c = drawingCases.find(c => c.id === map.caseId)!; assert(c, "Unknown drawing case");
  const reconstructed: number[] = [], stride = map.method === "scanline" ? SIZE : 64;
  for (let start = 0; start < SIZE * SIZE; start += stride) {
    const id = `drawing-v1/${c.id}/${map.method}/${start}`, response = responses.get(id);
    const body = drawingPayload(c, map.method, Array.from({ length: stride }, (_, i) => start + i), reconstructed);
    assert(response?.requestHash === hash(body), `Drawing request differs: ${id}`);
    for (let i = start; i < start + stride; i++) reconstructed.push(intensity(response.output.answers[`pixel_${i}`], map.method));
  }
  assert(hash(reconstructed) === hash(map.values), `Pixels differ: ${map.id}`);
  assert(hash(reference(c)) === hash(map.reference), `Reference differs: ${map.id}`);
  assert(hash(drawingMetrics(reconstructed, reference(c))) === hash(map.metrics), `Metrics differ: ${map.id}`);
  pixels += reconstructed.length;
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const policies = [...new Set(t.episodes.map((e: any) => e.policy))] as Policy[];
const tetris = policies.map(policy => { const es = t.episodes.filter((e: any) => e.policy === policy); return { policy, episodes: es.length, meanPieces: mean(es.map((e: any) => e.state.index)), meanLines: mean(es.map((e: any) => e.state.lines)), totalDecisions: es.reduce((n: number, e: any) => n + e.modelDecisions, 0), topOuts: es.filter((e: any) => e.state.status === "top-out").length, firstPlacementChoices: es.flatMap((e: any) => e.frames).filter((f: any) => f.value === "p0").length }; });
const drawing = Object.keys(drawingMethods).map(method => { const ms = d.maps.filter((m: any) => m.method === method && m.group === "geometry"); return { method, geometryCases: ms.length, meanIoU: mean(ms.map((m: any) => m.metrics.iou)), meanPixelAccuracy: mean(ms.map((m: any) => m.metrics.pixelAccuracy)) }; });
const report = { verified: true, episodes: t.episodes.length, transitions, modelDecisions, maps: d.maps.length, pixels, acceptedRequests: responses.size, transportAttempts: events.filter(e => e.kind === "attempt").length, tetris, drawing };
writeFileSync(resolve(here, "verification.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
