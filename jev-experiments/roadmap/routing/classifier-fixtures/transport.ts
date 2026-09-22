/** Authored subprocess fixture. Every fetch is intercepted; none reaches a network. */
import { appendFileSync } from "node:fs";
const record = (event: unknown) => appendFileSync(process.env.JEV_FIXTURE_EVENTS!, JSON.stringify(event) + "\n");
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = JSON.parse(String(init?.body));
  const scenario = process.env.JEV_FIXTURE_SCENARIO;
  if (url === "https://ai-gateway.vercel.sh/typesafe/v1/systemone") {
    record({kind: "native-classifier", request: body});
    if (scenario === "delayed") {
      await new Promise(resolve => setTimeout(resolve, 150)); // Deliberately ignores AbortSignal.
      record({kind: "late-classifier-response"});
    }
    const category = scenario === "tests" ? "test-writing" : "bug-fix";
    const hard = scenario !== "easy";
    const probabilities = Object.fromEntries(Object.keys(body.questions.category.criteria).map(key => [key, Number(key === category)]));
    const response = {
      model: "authored-native-classifier",
      answers: {
        category: {type: "choice", choice: category, probabilities},
        difficulty: {type: "score", score: hard ? 3.2 : 0.8, probabilities: {"0": hard ? .2 : .8, "1": 0, "2": 0, "3": 0, "4": hard ? .8 : .2}},
      },
      usage: {input_tokens: 20, output_tokens: 10, total_tokens: 30},
      ...(scenario === "unknown-cost" ? {} : {provider_metadata: {gateway: {cost: "0.002", generationId: "authored-classifier-attempt"}}}),
    };
    if (scenario === "http-error") return Response.json({...response, error: {message: "Authored refusal"}}, {status: 503});
    if (scenario === "malformed") response.answers.category.probabilities = {unexpected: 1};
    return Response.json(response);
  }
  if (url === "https://delegates.fixture.invalid/chat") {
    record({kind: "destination", model: body.model, request: body});
    return Response.json({model: body.model, choices: [{message: {content: JSON.stringify({kind: "answer", text: `authored artifact from ${body.model}`})}}], usage: {prompt_tokens: 20, completion_tokens: 10}});
  }
  record({kind: "unexpected-network", origin: new URL(url).origin, path: new URL(url).pathname});
  throw Error("Unexpected network request blocked by authored fixture.");
}) as typeof fetch;
