import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  evaluate,
  GatewayError,
} from "../experience-prototypes/scripts/local-model";
import {
  readRecord,
  writeRecord,
} from "../experience-prototypes/scripts/records";
import { CASES, comparePreferences } from "./cases";
import {
  CONTRACT_VERSION,
  MENU_REVISION,
  FIELDS,
  recordingPayload,
  interpret,
  candidates,
  type ModelResponse,
} from "./engine";

const output = fileURLToPath(new URL("./cafe.jsonl", import.meta.url));
const previous = existsSync(output) ? readRecord(output) : null;
const rows: any[] = previous?.result?.rows ?? [];
const failures: any[] = previous?.result?.providerFailures ?? [];
const started = previous?.manifest?.created ?? new Date().toISOString();
function checkpoint() {
  const completed = rows.filter((r) => r.response);
  const exact = completed.filter((r) => r.score.exact).length;
  const byCategory = Object.fromEntries(
    [...new Set(CASES.map((c) => c.category))].map((category) => {
      const group = completed.filter((r) => r.category === category);
      return [
        category,
        {
          planned: CASES.filter((c) => c.category === category).length,
          completed: group.length,
          exact: group.filter((r) => r.score.exact).length,
        },
      ];
    }),
  );
  writeRecord(output, {
    manifest: {
      experiment: "cafe-jev",
      created: started,
      updated: new Date().toISOString(),
      status: completed.length === CASES.length ? "complete" : "partial",
      model: "typesafe-ai/jev",
      contractVersion: CONTRACT_VERSION,
      menuRevision: MENU_REVISION,
      authored: true,
    },
    result: {
      version: CONTRACT_VERSION,
      menuRevision: MENU_REVISION,
      rows,
      providerFailures: failures,
      coverage: {
        declared: CASES.map((c) => c.id),
        planned: CASES.length,
        completed: completed.length,
        missing: CASES.filter((c) => !completed.some((r) => r.id === c.id)).map(
          (c) => c.id,
        ),
        partialStates: 81,
        realizationPerState: 1,
        optionOrders: 1,
        limitation:
          "Authored development fixture, not the proposed locked 120-customer evaluation. One direct wording per finite state. Customer outcomes and clarification quality are separate from extraction accuracy.",
      },
      metrics: {
        extractionExact: { numerator: exact, denominator: completed.length },
        extractionByField: Object.fromEntries(
          FIELDS.map((f) => [
            f,
            {
              numerator: completed.filter((r) => r.score.perField[f]).length,
              denominator: completed.length,
            },
          ]),
        ),
        byCategory,
        rawFeasibleSetExact: {
          numerator: completed.filter((r) => r.score.feasibleSetExact).length,
          denominator: completed.length,
        },
        rawSuggestedHardViolations: completed.filter(
          (r) => r.score.rawSuggestedHardViolation,
        ).length,
        guardedSuggestedHardViolations: completed.filter(
          (r) => r.score.guardedSuggestedHardViolation,
        ).length,
        providerFailedBatches: failures.length,
        completedBatchRetries: completed.reduce(
          (n, r) => n + (r.batchFirst ? (r.response.retries ?? 0) : 0),
          0,
        ),
      },
    },
  });
}
checkpoint();
// Six independent cases = 96 typed questions. Retry and checkpoint one batch at a
// time. The gateway already retries transient HTTP failures with bounded backoff.
const pending = CASES.filter(
  (c) => !rows.some((r) => r.id === c.id && r.response),
);
const batchSize = Number(process.env.CAFE_BATCH_SIZE ?? 1);
const batchRetries = new Map<string, number>();
for (let i = 0; i < pending.length; i += batchSize) {
  const batch = pending.slice(i, i + batchSize);
  const { state, questions } = recordingPayload(
    Object.fromEntries(batch.map((c) => [c.id, c.input])),
  );
  try {
    const response = await evaluate(
      { state, questions },
      { deadlineMs: 48000 },
    );
    for (const [index, c] of batch.entries()) {
      const prefix = `${c.id}__`;
      const local: ModelResponse = {
        ...response,
        answers: Object.fromEntries(
          Object.entries(response.answers)
            .filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => [k.slice(prefix.length), v]),
        ),
      };
      const interpreted = interpret(local, c.input);
      const expectedFeasible = candidates(c.expected, c.input.inventory);
      const expectedIds = expectedFeasible.map((r) => JSON.stringify(r)).sort();
      const actualIds = interpreted.feasible
        .map((r) => JSON.stringify(r))
        .sort();
      const rawFamily = local.answers.family?.value;
      rows.push({
        id: c.id,
        category: c.category,
        customerId: c.customerId,
        requestId: `${started}:${c.id}`,
        contractVersion: CONTRACT_VERSION,
        menuRevision: MENU_REVISION,
        input: c.input,
        expected: c.expected,
        batchFirst: index === 0,
        source: "recorded",
        response: local,
        interpreted: {
          preferences: interpreted.preferences,
          question: interpreted.question,
          rawQuestion: interpreted.rawQuestion,
          suggested: interpreted.suggested,
          errors: interpreted.errors,
          feasibleCount: interpreted.feasible.length,
        },
        score: {
          ...comparePreferences(interpreted.preferences, c.expected),
          feasibleSetExact:
            JSON.stringify(expectedIds) === JSON.stringify(actualIds),
          expectedFeasibleCount: expectedIds.length,
          rawSuggestedHardViolation:
            rawFamily !== "none" &&
            !expectedFeasible.some((r) => r.family === rawFamily),
          guardedSuggestedHardViolation: Boolean(
            interpreted.suggested &&
              !expectedFeasible.some(
                (r) =>
                  JSON.stringify(r) === JSON.stringify(interpreted.suggested),
              ),
          ),
        },
      });
    }
    checkpoint();
    console.log(
      `${rows.length}/${CASES.length} cases recorded; latest ${batch.map((c) => c.id).join(", ")}`,
    );
  } catch (error) {
    failures.push({
      caseIds: batch.map((c) => c.id),
      at: new Date().toISOString(),
      status: error instanceof GatewayError ? error.status : "network",
      message: error instanceof Error ? error.message : String(error),
      attempts: error instanceof GatewayError ? error.attempts : [],
    });
    checkpoint();
    console.log(
      `Provider batch unavailable: ${batch.map((c) => c.id).join(", ")}. Checkpoint retained.`,
    );
    const retryCount = batchRetries.get(batch[0].id) ?? 0;
    if (error instanceof GatewayError && error.retryAfterMs && retryCount < 3) {
      // Respect a long provider retry-after even when it exceeds one gateway
      // request deadline. Work on the same cases again after this bounded pause.
      const pause = Math.min(60000, error.retryAfterMs + 250);
      console.log(
        `Respecting retry-after for ${Math.round(pause / 1000)} seconds.`,
      );
      await new Promise((resolve) => setTimeout(resolve, pause));
      batchRetries.set(batch[0].id, retryCount + 1);
      i -= batchSize;
    }
  }
}
checkpoint();
