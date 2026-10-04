/**
 * How Generated UI asks Jev, shared by the server (server/compose.ts) and the scene's "Build this".
 * json-render builds each request from what's already built, so a composition is a loop of
 * requests, one per element, until Jev picks "finish". Build this shows the first one: what
 * "Compose a new interface" sends for the prompt in the box. It is made by the same
 * `experimental_composeSpec` call the server runs, stopped before it sends anything.
 */
import {
  experimental_composeSpec,
  type Experimental_ComposeSpecOptions,
  type Experimental_CompositionEvaluator,
} from "@json-render/core";
import { uiCatalog, uiCandidates, uiInitial } from "./ui-catalog.js";

export type ComposeBody = {
  prompt: string;
  domain?: "settings" | "apartments" | "event";
  strategy?: "sequential" | "batch";
  state?: Record<string, unknown>;
  spec?: Experimental_ComposeSpecOptions["initialSpec"];
};

// json-render uses undefined for absent optional element fields. Materialize
// that documented library boundary explicitly; other non-JSON state still fails.
export function compositionState(state: any) {
  if (!Array.isArray(state?.already_built)) return state;
  return {
    ...state,
    context: state.context ?? {},
    already_built: state.already_built.map((element: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(element).filter(
          ([key, value]) => value !== undefined || !["content", "children", "slots"].includes(key),
        ),
      ),
    ),
  };
}

/** The composer's options for a checked request body; `evaluate` gets each request as Jev should. */
export function composeOptions(
  body: ComposeBody,
  evaluate: Experimental_CompositionEvaluator,
  signal?: AbortSignal,
): Experimental_ComposeSpecOptions {
  return {
    catalog: uiCatalog,
    candidates: uiCandidates(body.domain ?? "settings"),
    strategy: body.strategy ?? "sequential",
    prompt: body.prompt,
    initialState: body.state ?? uiInitial,
    ...(body.spec ? { initialSpec: body.spec } : {}),
    evaluate: (request) => evaluate({ ...request, state: compositionState(request.state) }),
    instructions: {
      next: "Prefer shallow layouts. A Card already groups its children. Add requested visible content before optional layout wrappers; complete apartment cards already include rent, commute and a shortlist button.",
    },
    signal,
    maxSteps: body.spec ? 16 : 32,
    maxElements: 22,
    maxDepth: 5,
  };
}

const STOP = Symbol("first request");

/** The first request the composer sends for `body`, built without sending it; null if it sends none. */
export async function firstCompositionRequest(
  body: ComposeBody,
): Promise<{ state: Record<string, unknown>; questions: Record<string, unknown> } | null> {
  let first: { state: Record<string, unknown>; questions: Record<string, unknown> } | null = null;

  const options = composeOptions(body, async ({ state, questions }) => {
    first = { state, questions };
    throw STOP;
  });

  try {
    for await (const _ of experimental_composeSpec(options));
  } catch (e) {
    if (e !== STOP && !first) return null;
  }

  return first;
}
