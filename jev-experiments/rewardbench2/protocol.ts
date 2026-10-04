import { createHash } from "node:crypto";
import { batchPayload, type Case, type Job } from "./wire";
export { batchPayload, instructions, payload, RUBRIC, scoreQuestion, type Candidate, type Case, type Job } from "./wire";

export const DATASET_REVISION = "7ff08853b0d5686e79b13fda8677024f566a104a";
export const SCORER_REVISION = "05a9005efb607249822c193590c8ecab87c77052";
export const SUBSETS = [
  "Focus",
  "Factuality",
  "Math",
  "Safety",
  "Precise IF",
  "Ties",
];
export function pack(raw: any): Case {
  const combined = [...raw.chosen, ...raw.rejected]
    .map((text, i) => ({
      text,
      chosen: i < raw.chosen.length,
      model:
        raw.models.length === 1
          ? raw.models[0]
          : (raw.models[i] ?? "Not supplied"),
      order: createHash("sha256").update(`42:${raw.id}:${i}`).digest("hex"),
    }))
    .sort((a, b) => a.order.localeCompare(b.order));
  const candidates = combined.map(({ order, ...c }, i) => ({
    ...c,
    label: i < 26 ? String.fromCharCode(65 + i) : `A${i - 25}`,
  }));
  const row = {
    id: String(raw.id),
    subset: raw.subset,
    prompt: raw.prompt,
    candidates,
    num_correct: raw.chosen.length,
    num_incorrect: raw.rejected.length,
  };
  return {
    ...row,
    input_hash: createHash("sha256").update(JSON.stringify(row)).digest("hex"),
  };
}
export function batches(rows: Case[], maxBytes = 90000, maxQuestions = 128) {
  const output: Job[][] = [];
  let current: Job[] = [];
  for (const row of rows)
    for (const candidate of row.candidates.filter(
      (c) => !Number.isFinite(c.score),
    )) {
      const next = { row, candidate };
      if (
        current.length &&
        (current.length >= maxQuestions ||
          Buffer.byteLength(JSON.stringify(batchPayload([...current, next]))) >
            maxBytes)
      ) {
        output.push(current);
        current = [];
      }
      current.push(next);
      if (Buffer.byteLength(JSON.stringify(batchPayload(current))) > maxBytes)
        throw Error("Single candidate exceeds the request limit");
    }
  if (current.length) output.push(current);
  return output;
}
