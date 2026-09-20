import { experimental_composeSpec } from "@json-render/core";
import { uiCatalog, uiCandidates, uiInitial } from "../src/ui-catalog.js";
import { evaluate } from "./gateway.js";
export async function* compose(body: any, signal: AbortSignal) {
  if (typeof body?.prompt !== "string" || body.prompt.length > 4000)
    throw new Error("Supply a prompt under 4000 characters.");
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
        { signal, deadlineMs: 22000 },
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
