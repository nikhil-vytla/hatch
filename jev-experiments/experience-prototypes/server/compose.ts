import { experimental_composeSpec } from "@json-render/core";
import { uiCatalog, uiCandidates, uiInitial } from "../src/ui-catalog.js";
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
  yield* experimental_composeSpec({
    catalog: uiCatalog,
    candidates: uiCandidates(body.domain ?? "settings"),
    strategy: body.strategy ?? "sequential",
    prompt: body.prompt,
    initialState: body.state ?? uiInitial,
    ...(body.spec ? { initialSpec: body.spec } : {}),
    evaluate: async ({ state, questions, signal }) => {
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
    instructions: {
      next: "Prefer shallow layouts. A Card already groups its children. Add requested visible content before optional layout wrappers; complete apartment cards already include rent, commute and a shortlist button.",
    },
    signal,
    maxSteps: body.spec ? 16 : 32,
    maxElements: 22,
    maxDepth: 5,
  });
}
