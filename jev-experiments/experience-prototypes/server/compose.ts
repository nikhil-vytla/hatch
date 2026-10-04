import { experimental_composeSpec } from "@json-render/core";
import { composeOptions } from "../src/composition-request.js";
import { evaluate, GatewayError } from "./gateway.js";
export async function* compose(body: any, signal: AbortSignal, apiKey: string) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some(
      (key) => !["prompt", "domain", "strategy", "state", "spec"].includes(key),
    ) ||
    Buffer.byteLength(JSON.stringify(body)) > 100000 ||
    (body.domain !== undefined &&
      !["settings", "apartments", "event"].includes(body.domain)) ||
    (body.strategy !== undefined &&
      !["sequential", "batch"].includes(body.strategy))
  )
    throw new GatewayError("Invalid composition request.", 400);
  if (
    typeof body.prompt !== "string" ||
    !body.prompt.trim() ||
    body.prompt.length > 4000
  )
    throw new GatewayError("Supply a prompt under 4000 characters.", 400);
  // The options, and the state each request carries, live with the scene's "Build this".
  yield* experimental_composeSpec(
    composeOptions(
      body,
      async ({ state, questions, signal }) => {
        const r = await evaluate(
          { state, questions },
          { apiKey, signal, deadlineMs: 22000 },
        );
        return {
          answers: Object.fromEntries(
            Object.entries(r.answers).map(([k, a]) => [
              k,
              { choice: a.value, confidence: a.confidence ?? undefined },
            ]),
          ),
        };
      },
      signal,
    ),
  );
}
