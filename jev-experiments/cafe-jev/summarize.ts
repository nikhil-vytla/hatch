import { fileURLToPath } from "node:url";
import {
  readRecord,
  writeRecord,
} from "../experience-prototypes/scripts/records";
import { CASES, comparePreferences } from "./cases";
import {
  CUSTOMERS,
  FIELDS,
  candidates,
  constraintErrors,
  interpret,
  recordingPayload,
  scoreCustomer,
  usefulQuestions,
  type Field,
} from "./engine";

// Recompute derived judgments from preserved raw model outputs after code fixes.
// This never changes a model answer, expected annotation or provider attempt.
const path = fileURLToPath(new URL("./cafe.jsonl", import.meta.url));
const document = readRecord(path);
const result = document.result;
for (const row of result.rows) {
  const c = CASES.find((c) => c.id === row.id)!;
  const decision = interpret(row.response, c.input);
  const expectedFeasible = candidates(c.expected, c.input.inventory);
  const family = row.response.answers.family.value;
  const question = row.response.answers.question.value;
  const legalQuestions = usefulQuestions(c.expected, expectedFeasible);
  row.interpreted = {
    preferences: decision.preferences,
    question: decision.question,
    rawQuestion: decision.rawQuestion,
    suggested: decision.suggested,
    errors: decision.errors,
    feasibleCount: decision.feasible.length,
  };
  row.score = {
    ...comparePreferences(decision.preferences, c.expected),
    feasibleSetExact:
      JSON.stringify(decision.feasible.map((r) => JSON.stringify(r)).sort()) ===
      JSON.stringify(expectedFeasible.map((r) => JSON.stringify(r)).sort()),
    expectedFeasibleCount: expectedFeasible.length,
    rawSuggestedHardViolation:
      family !== "none" && !expectedFeasible.some((r) => r.family === family),
    guardedSuggestedHardViolation: Boolean(
      decision.suggested &&
        constraintErrors(decision.suggested, c.expected, c.input.inventory)
          .length,
    ),
    guardedExtractedConstraintViolation: Boolean(
      decision.suggested &&
        constraintErrors(
          decision.suggested,
          decision.preferences,
          c.input.inventory,
        ).length,
    ),
    rawAskedQuestion: FIELDS.includes(question),
    rawQuestionUsefulAgainstGold: FIELDS.includes(question)
      ? legalQuestions.includes(question as Field)
      : null,
    rawNoMatch: question === "no_match",
    expectedNoMatch: expectedFeasible.length === 0,
    rawPreferenceExact: FIELDS.every(
      (f) =>
        row.response.answers[f]?.value ===
        (c.expected[f].status === "unknown" ||
        c.expected[f].status === "conflicting"
          ? c.expected[f].status
          : `${c.expected[f].status}_${c.expected[f].value}`),
    ),
  };
  const customer = CUSTOMERS.find((customer) => customer.id === row.customerId);
  if (customer)
    row.customerOutcome = decision.suggested
      ? scoreCustomer(customer, decision.suggested, c.input.inventory)
      : {
          success: false,
          abstained: true,
          goalFeasible: candidates(c.expected, c.input.inventory).length > 0,
        };
}
const completed = result.rows;
const groups: any[][] = [];
for (const row of completed) {
  if (row.batchFirst || !groups.length) groups.push([]);
  groups.at(-1)!.push(row);
}
result.requestBatches = groups.map((group, index) => {
  const id = `batch_${String(index + 1).padStart(3, "0")}`;
  for (const row of group) row.batchId = id;
  return {
    id,
    caseIds: group.map((r) => r.id),
    payload: recordingPayload(
      Object.fromEntries(group.map((r) => [r.id, r.input])),
    ),
    note: "Reconstructed losslessly from the committed shared prompt builder, original public input and recorded batch boundaries. Case names prefix the shared choice questions; live UI uses the same choice schema for one public transcript.",
  };
});
const successfulBatches = completed.filter((r: any) => r.batchFirst);
const attempts =
  successfulBatches.reduce(
    (n: number, r: any) => n + r.response.attempts.length,
    0,
  ) +
  result.providerFailures.reduce(
    (n: number, f: any) => n + f.attempts.length,
    0,
  );
const matrix = {
  truePositive: 0,
  falsePositive: 0,
  falseNegative: 0,
  trueNegative: 0,
};
for (const r of completed)
  matrix[
    r.score.rawNoMatch
      ? r.score.expectedNoMatch
        ? "truePositive"
        : "falsePositive"
      : r.score.expectedNoMatch
        ? "falseNegative"
        : "trueNegative"
  ]++;
const latencies = successfulBatches
  .map((r: any) => r.response.latency_ms)
  .sort((a: number, b: number) => a - b);
result.metrics = {
  ...result.metrics,
  extractionExact: {
    numerator: completed.filter((r: any) => r.score.exact).length,
    denominator: completed.length,
  },
  rawPreferenceExact: {
    numerator: completed.filter((r: any) => r.score.rawPreferenceExact).length,
    denominator: completed.length,
  },
  extractionByField: Object.fromEntries(
    FIELDS.map((f) => [
      f,
      {
        numerator: completed.filter((r: any) => r.score.perField[f]).length,
        denominator: completed.length,
      },
    ]),
  ),
  rawFeasibleSetExact: {
    numerator: completed.filter((r: any) => r.score.feasibleSetExact).length,
    denominator: completed.length,
  },
  rawSuggestedHardViolations: completed.filter(
    (r: any) => r.score.rawSuggestedHardViolation,
  ).length,
  guardedSuggestedHardViolations: completed.filter(
    (r: any) => r.score.guardedSuggestedHardViolation,
  ).length,
  guardedExtractedConstraintViolations: completed.filter(
    (r: any) => r.score.guardedExtractedConstraintViolation,
  ).length,
  rawUsefulQuestions: {
    numerator: completed.filter(
      (r: any) => r.score.rawQuestionUsefulAgainstGold === true,
    ).length,
    denominator: completed.filter((r: any) => r.score.rawAskedQuestion).length,
  },
  rawNoMatchConfusion: matrix,
  completedPhysicalBatches: successfulBatches.length,
  totalProviderAttempts: attempts,
  completedBatchLatencyMs: {
    median: latencies[Math.floor(latencies.length / 2)] ?? null,
    p95: latencies[Math.floor(latencies.length * 0.95)] ?? null,
  },
  customerOpeningOutcomes: completed
    .filter((r: any) => r.customerOutcome)
    .map((r: any) => ({ id: r.id, ...r.customerOutcome })),
};
result.coverage.completed = completed.length;
result.coverage.missing = CASES.filter(
  (c) => !completed.some((r: any) => r.id === c.id),
).map((c) => c.id);
document.manifest.status = result.coverage.missing.length
  ? "partial"
  : "complete";
document.manifest.derivedMetricsUpdated = new Date().toISOString();
writeRecord(path, document);
console.log(
  JSON.stringify(
    {
      coverage: result.coverage,
      metrics: result.metrics,
      extractionErrors: completed
        .filter((r: any) => !r.score.exact)
        .map((r: any) => ({
          id: r.id,
          fields: FIELDS.filter((f) => !r.score.perField[f]),
        })),
    },
    null,
    2,
  ),
);
