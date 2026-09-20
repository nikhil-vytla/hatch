import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluate } from "../experience-prototypes/scripts/local-model";
import { pack, batchPayload } from "./protocol";

const a = pack({
  id: "fixture-a",
  subset: "Focus",
  prompt: "What is the capital of France?",
  chosen: ["Paris."],
  rejected: [],
  models: ["authored fixture"],
});
const b = pack({
  id: "fixture-b",
  subset: "Focus",
  prompt: "Name two colors.",
  chosen: ["Blue and green."],
  rejected: [],
  models: ["authored fixture"],
});
const first = { row: a, candidate: a.candidates[0] },
  second = { row: b, candidate: b.candidates[0] };
const sequence = [
  "alone",
  "batched",
  "batched",
  "alone",
  "alone",
  "batched",
  "batched",
  "alone",
];
const rows = [];
for (const condition of sequence) {
  const response = await evaluate(
    batchPayload(condition === "alone" ? [first] : [first, second]),
    { deadlineMs: 300000, wait: (ms) => Bun.sleep(ms + 750) },
  );
  rows.push({
    condition,
    raw_score: response.answers.q0.value,
    confidence: response.answers.q0.confidence,
    probabilities: response.answers.q0.probabilities,
    attempts: response.attempts,
  });
  await Bun.sleep(1000);
}
const range = (condition: string) => {
  const scores = rows
    .filter((r) => r.condition === condition)
    .map((r) => Number(r.raw_score));
  return {
    min: Math.min(...scores),
    max: Math.max(...scores),
    range: Math.max(...scores) - Math.min(...scores),
    mean: scores.reduce((a, b) => a + b, 0) / scores.length,
  };
};
const report = {
  model: "typesafe-ai/jev",
  checked_at: new Date().toISOString(),
  fixture:
    "The same France/Paris score question, alone or with an unrelated colors question. Authored fixtures, excluded from benchmark scoring.",
  rows,
  alone: range("alone"),
  batched: range("batched"),
  scope:
    "Four repeats per condition on one fixture characterize observed variation. They do not establish a general batching effect or exact reproducibility.",
};
writeFileSync(
  resolve(import.meta.dir, "repeat-check.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    ...report,
    rows: rows.map(({ condition, raw_score }) => ({ condition, raw_score })),
  }),
);
