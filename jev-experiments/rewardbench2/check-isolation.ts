import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluate } from "../experience-prototypes/scripts/local-model";
import { pack, batchPayload } from "./protocol";

// Authored transport fixtures, never part of RewardBench 2's score.
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
const solo = await evaluate(batchPayload([first]), { deadlineMs: 120000 });
const together = await evaluate(batchPayload([first, second]), {
  deadlineMs: 120000,
});
const difference = Math.abs(
  Number(solo.answers.q0.value) - Number(together.answers.q0.value),
);
const report = {
  model: "typesafe-ai/jev",
  checked_at: new Date().toISOString(),
  fixture:
    "One identical question evaluated alone and alongside an unrelated question. The shared evaluation policy stays identical.",
  solo_score: solo.answers.q0.value,
  batched_score: together.answers.q0.value,
  absolute_difference: difference,
  passed: difference < 1e-10,
  scope:
    "One fixture comparison tests exact numerical equality, not whether questions can read one another. A difference needs identical-call repeat controls before attributing it to batching.",
};
writeFileSync(
  resolve(import.meta.dir, "isolation-check.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
