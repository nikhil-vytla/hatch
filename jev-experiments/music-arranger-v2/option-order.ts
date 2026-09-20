import { existsSync } from "node:fs";
import { evaluate, GatewayError } from "../experience-prototypes/scripts/local-model";
import { readRecord, writeRecord } from "../experience-prototypes/scripts/records";
const directory = new URL("./", import.meta.url).pathname;
const music = readRecord(`${directory}music-v2.jsonl`);
// Freeze a completed broad-brief context. No completed recording is replaced.
const original = music.result.rows.find((r: any) => r.id === "original-8").calls.find((c: any) => c.stage === "phrase-2" && c.result);
const path = `${directory}option-order.jsonl`;
const record: any = existsSync(path) ? readRecord(path) : { manifest: { experiment: "music-v2-option-order", created: new Date().toISOString(), status: "recording", protocol: "One fixed warm-home phrase-two state, four presentation conditions, two repeats each. Full descriptions and event content held constant. Conditions vary only option/candidate order and candidate identifiers. This small diagnostic cannot establish general order invariance or listening quality.", reference: { case: "original-8", stage: "phrase-2", original_choice: original.result.answers.phrase.value }, planned: 8 }, result: { rows: [] } };
const save = () => writeRecord(path, record);
const names = ["cedar", "linen", "pebble", "copper", "moss", "harbor"];
for (const condition of ["original", "reversed", "neutral", "neutral-reversed"]) for (let repeat = 0; repeat < 2; repeat++) {
  const id = `${condition}-${repeat + 1}`;
  let row = record.result.rows.find((r: any) => r.id === id);
  if (row?.result) continue;
  if (row?.error && !row.retryable) continue;
  const request = structuredClone(original.request), pool = request.state.candidates;
  const mapping = Object.fromEntries(pool.map((c: any, i: number) => [c.id, { id: condition.startsWith("neutral") ? names[i] : c.id, contour: c.contour }]));
  request.questions.phrase.criteria = Object.fromEntries(Object.entries(request.questions.phrase.criteria).map(([id, text]) => [mapping[id].id, text]));
  request.state.candidates = pool.map((c: any) => ({ ...c, id: mapping[c.id].id }));
  if (condition.endsWith("reversed") || condition === "reversed") {
    request.questions.phrase.criteria = Object.fromEntries(Object.entries(request.questions.phrase.criteria).reverse());
    request.state.candidates.reverse();
  }
  if (!row) { row = { id, condition, repeat: repeat + 1, request, mapping, attempts: [], started: new Date().toISOString() }; record.result.rows.push(row); }
  else { row.previous_failures ??= []; row.previous_failures.push({ error: row.error, attempts: row.attempts }); delete row.error; row.attempts = []; }
  save();
  try {
    row.result = await evaluate(request, { deadlineMs: 120000, onAttempt: a => { row.attempts.push(a); save(); } });
    row.selected_contour = Object.values(mapping).find((m: any) => m.id === row.result.answers.phrase.value)?.contour;
    row.finished = new Date().toISOString(); save(); console.log(`${id}: ${row.selected_contour}`);
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
    row.retryable = e instanceof GatewayError && [408,429,500,502,503,504].includes(e.status) && !/invalid/i.test(e.message);
    save(); console.log(`${id}: unavailable`);
  }
}
record.manifest.status = record.result.rows.filter((r: any) => r.result).length === 8 ? "complete" : "partial";
record.result.summary = record.result.rows.map((r: any) => ({ condition: r.condition, repeat: r.repeat, contour: r.selected_contour ?? null, error: r.error ?? null }));
save(); console.log(JSON.stringify(record.result.summary, null, 2));
