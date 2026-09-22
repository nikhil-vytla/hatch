/** Provider-free audit probes. All HTTP responses below are authored fixtures. */
import { validate } from "../experience-prototypes/server/gateway";
import { validateRequest } from "../roadmap/runtime/contract";
import { createJevAdapter } from "../roadmap/runtime/jev";
import { compile } from "../adapters/typescript/index";

const variants = {
  plainNoul: { type: "noul", instructions: "Is it eligible?" },
  structuredInstruction: { type: "choice", instructions: { question: "Which?", facts: [1, 2] }, criteria: { a: "A", b: "B" } },
  structuredChoice: { type: "choice", instructions: "Which?", criteria: { a: { meaning: "A" }, b: { meaning: "B" } } },
  structuredScore: { type: "score", instructions: "How much?", criteria: [{ meaning: "low" }, { meaning: "high" }] },
  noulCriteria: { type: "noul", instructions: "Is it eligible?", criteria: { true: "All rules hold", false: "A rule fails" } },
  nullInstruction: { type: "choice", instructions: null, criteria: { a: "A", b: "B" } },
  nullChoiceDescription: { type: "choice", instructions: "Which?", criteria: { a: null, b: "B" } },
  scoreEleven: { type: "score", instructions: "Which level?", criteria: Array.from({ length: 11 }, (_, i) => String(i)) },
};
const gatewayValidation: Record<string, string> = {};
for (const [id, q] of Object.entries(variants)) {
  try {
    validate({ state: "Example", questions: { q } });
    gatewayValidation[id] = "accepted";
  } catch (error) {
    gatewayValidation[id] = error instanceof Error ? error.message : "rejected";
  }
}
// Untrusted JSON can contain fields excluded by the TypeScript static type.
const request: any = {
  schemaVersion: "1", requestId: "probe", state: { text: "Example" },
  questions: [
    { id: "q", kind: "ordinal", prompt: "Which level?", min: 10, max: 30, step: 10, criteria: [{ meaning: "low" }, { meaning: "medium" }, { meaning: "high" }] },
    { id: "b", kind: "boolean", prompt: "Is it eligible?", criteria: { true: { rules: ["a", "b"] }, false: "Any failure" } },
    { id: "c", kind: "choice", prompt: "Which option?", options: [{ id: "a", label: "A", description: "Detail A" }, { id: "b", label: "B" }] },
  ],
};
let wire: any;
const fixtureFetch = (async (_url: unknown, init: any) => {
  wire = JSON.parse(init.body);
  return new Response(JSON.stringify({ model: "typesafe-ai/jev", answers: {
    q: { type: "score", score: 1.6, confidence: 0.5, legend: { "0": "low", "1": "medium", "2": "high" }, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 } },
    b: { type: "noul", noul: 0.6 },
    c: { type: "choice", choice: "a", confidence: 0.4, probabilities: { a: 0.7, b: 0.3 } },
  } }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;
const output = await createJevAdapter("mock-only", fixtureFetch).decide(request);
const schema = {
  type: "object", required: ["rating"], properties: {
    rating: { type: "number", minimum: 0, maximum: 1, description: "Severity?", "x-jev-levels": ["routine", "severe"] },
  },
};
console.log(JSON.stringify({
  networkCalls: 0,
  gatewayValidation,
  sharedExtraFieldsIssues: validateRequest(request),
  sharedElevenLevelIssues: validateRequest({ ...request, questions: [{ id: "eleven", kind: "ordinal", prompt: "Which level?", min: 0, max: 10 }] }),
  mockedWireQuestions: wire.questions,
  adaptedDecisions: output.decisions,
  twoLevelScoreCompilation: compile(schema),
}, null, 2));
