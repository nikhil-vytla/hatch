import { expect, test } from "bun:test";
import { evaluate, GatewayError, type Payload } from "../experience-prototypes/server/gateway";
import { accountingIssue } from "../roadmap/runtime/accounting";

const payload: Payload = {
  state: { document: "Authored public fixture" },
  questions: {
    category: { type: "choice", instructions: { task: "Classify" }, criteria: { a: { meaning: "A" }, b: ["B", null] } },
    ready: { type: "noul", instructions: ["Check readiness"], criteria: { false: "Missing", true: { evidence: "Present" } } },
    severity: { type: "score", instructions: "Rate", criteria: ["low", { meaning: "medium" }, ["high"]] },
  },
};
function reply() {
  return {
    model: "jev-authored-fixture",
    answers: {
      category: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, legend: payload.questions.category.criteria },
      ready: { type: "noul", noul: 0.75, probabilities: { false: 0.25, true: 0.75 }, legend: payload.questions.ready.criteria },
      severity: { type: "score", score: 1.3, probabilities: { "0": 0.2, "1": 0.3, "2": 0.5 }, legend: { "0": "low", "1": { meaning: "medium" }, "2": ["high"] } },
    },
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    provider_metadata: { gateway: { cost: "0.001", generationId: "authored-generation" } },
  };
}
const fetchReply = (body: unknown, status = 200) =>
  (async () => Response.json(body, { status, headers: { "Retry-After": "0" } })) as typeof fetch;
async function rejected(operation: Promise<unknown>): Promise<GatewayError> {
  try { await operation; } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    return error as GatewayError;
  }
  throw Error("Expected gateway rejection");
}

test("native questions preserve their JSON meanings and observed answer metadata", async () => {
  const result = await evaluate(payload, { apiKey: "fixture-only", fetcher: (async (url, init) => {
    expect(String(url)).toBe("https://ai-gateway.vercel.sh/typesafe/v1/systemone");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toEqual({ model: "typesafe-ai/jev", ...payload });
    return Response.json(reply());
  }) as typeof fetch });
  expect(result.model).toBe("jev-authored-fixture");
  expect(result.model_source).toBe("provider-reported");
  expect(result.answers.severity.value).toBe(1.3);
  expect(result.answers.category.legend).toEqual(payload.questions.category.criteria);
  expect(result.answers.ready.value).toBe(0.75);
  expect(result.cost_usd).toBe(0.001);
  expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 4, total_tokens: 14 });
  expect(accountingIssue(result.accounting)).toBeNull();
  expect(JSON.stringify(result)).not.toContain("fixture-only");
});

test("invalid native inputs fail before transport", async () => {
  let calls = 0;
  for (const input of [
    { ...payload, state: { lost: undefined } },
    { ...payload, questions: { q: { type: "score", instructions: "Rate", criteria: [1, 2] } } },
    { ...payload, questions: { q: { type: "noul", instructions: "Check", criteria: { true: "Present" } } } },
    { ...payload, model: "substitution" },
  ]) {
    const error = await rejected(evaluate(input as Payload, { apiKey: "fixture-only", fetcher: (async () => {
      calls++; return Response.json(reply());
    }) as typeof fetch }));
    expect(error.status).toBe(400);
    expect(error.accounting.attempts).toEqual([]);
  }
  expect(calls).toBe(0);
});

test("semantic failures preserve independently observed cost and identity without another request", async () => {
  const mutations = [
    (body: any) => { body.answers.severity.score = 100; },
    (body: any) => { body.answers.category.probabilities = { a: 1 }; },
    (body: any) => { body.answers.category.legend = { a: "Wrong", b: "B" }; },
    (body: any) => { body.answers.ready.probabilities = { false: 0.5, true: 0.5 }; },
    (body: any) => { delete body.answers.ready; },
  ];
  for (const mutate of mutations) {
    const body = reply(); mutate(body); let calls = 0;
    const error = await rejected(evaluate(payload, { apiKey: "fixture-only", fetcher: (async () => {
      calls++; return Response.json(body);
    }) as typeof fetch }));
    expect(error.status).toBe(502); expect(calls).toBe(1);
    expect(error.accounting.costUsd).toBe(0.001);
    expect(error.accounting.usage?.totalTokens).toBe(14);
    expect(error.accounting.attempts[0].model).toBe("jev-authored-fixture");
    expect(accountingIssue(error.accounting)).toBeNull();
  }
});

test("Score rejection retains the raw distribution and disagreement", async () => {
  const body = reply(); body.answers.severity.score = 0;
  const error = await rejected(evaluate(payload, { apiKey: "fixture-only", fetcher: fetchReply(body) }));
  expect(error.code).toBe("native_score_mismatch");
  expect(error.accounting.costUsd).toBe(0.001);
  const check = error.accounting.attempts[0].scoreChecks?.[0];
  expect(check?.questionId).toBe("severity");
  expect(check?.result.probabilities).toEqual([0.2, 0.3, 0.5]);
  expect(check?.result.normalizedExpectation).toBeCloseTo(1.3);
  expect(check?.result.accepted).toBe(false);
  expect(accountingIssue(error.accounting)).toBeNull();
});

test("an unknown earlier attempt prevents a claimed total; known retries are summed", async () => {
  for (const known of [false, true]) {
    let calls = 0;
    const result = await evaluate(payload, { apiKey: "fixture-only", wait: async () => {}, fetcher: (async () => {
      calls++;
      return Response.json(calls === 1 && !known ? {} : reply(), { status: calls === 1 ? 503 : 200 });
    }) as typeof fetch });
    expect(calls).toBe(2); expect(result.retries).toBe(1);
    expect(result.attempts.map(a => a.status)).toEqual([503, 200]);
    expect(result.cost_usd).toBe(known ? 0.002 : null);
    expect(result.usage).toEqual(known ? { input_tokens: 20, output_tokens: 8, total_tokens: 28 } : null);
    expect(result.attempts[1].costUsd).toBe(0.001);
    expect(result.accounting.providerAttempts).toBe("unknown");
    expect(accountingIssue(result.accounting)).toBeNull();
  }
});

test("one-attempt mode never retries transient or network failure", async () => {
  for (const network of [false, true]) {
    let calls = 0;
    const error = await rejected(evaluate(payload, { apiKey: "fixture-only", maxAttempts: 1, fetcher: (async () => {
      calls++; if (network) throw Error("Authored network failure");
      return Response.json(reply(), { status: 503 });
    }) as typeof fetch }));
    expect(calls).toBe(1); expect(error.status).toBe(503);
    expect(error.accounting.costUsd).toBe(network ? null : 0.001);
    expect(error.accounting.attempts[0].status).toBe(network ? "network" : 503);
  }
});

test("unknown model, partial usage and explicit zero remain distinct", async () => {
  const body: any = reply(); delete body.model; body.usage = { input_tokens: 10 };
  body.provider_metadata.gateway.cost = "0";
  const result = await evaluate(payload, { apiKey: "fixture-only", fetcher: fetchReply(body) });
  expect(result.model_source).toBe("configured-unverified");
  expect(result.cost_usd).toBe(0); expect(result.usage).toEqual({ input_tokens: 10 });
  for (const cost of [null, false, "", " ", "Infinity"]) {
    body.provider_metadata.gateway.cost = cost; body.usage = { input_tokens: 10, output_tokens: 4, total_tokens: 99 };
    const malformed = await evaluate(payload, { apiKey: "fixture-only", fetcher: fetchReply(body) });
    expect(malformed.cost_usd).toBeNull(); expect(malformed.usage).toBeNull();
    expect(malformed.attempts[0].issues).toContain("invalid_usage");
  }
});

test("caller cancellation prevents a late answer from becoming a success", async () => {
  const controller = new AbortController(); let resolve!: (response: Response) => void;
  const operation = evaluate(payload, { apiKey: "fixture-only", signal: controller.signal,
    fetcher: (() => new Promise<Response>(r => { resolve = r; })) as typeof fetch });
  controller.abort(); resolve(Response.json(reply()));
  const error = await rejected(operation);
  expect(error.code).toBe("cancelled"); expect(error.status).toBe(499);
  expect(error.accounting.costUsd).toBe(0.001);
  expect(error.accounting.attempts[0].issues).toContain("cancelled");
  expect(accountingIssue(error.accounting)).toBeNull();
  let calls = 0;
  await rejected(evaluate(payload, { apiKey: "fixture-only", signal: controller.signal,
    fetcher: (async () => { calls++; return Response.json(reply()); }) as typeof fetch }));
  expect(calls).toBe(0);
});

test("observer failures cannot trigger another paid request", async () => {
  for (const kind of ["attempt", "accounting"]) {
    let calls = 0;
    const error = await rejected(evaluate(payload, { apiKey: "fixture-only",
      fetcher: (async () => { calls++; return Response.json(reply()); }) as typeof fetch,
      onAttempt: kind === "attempt" ? () => { throw Error("Authored observer failure"); } : undefined,
      onAccounting: kind === "accounting" ? a => { if (a.attempts[0]?.status === 200) throw Error("Authored observer failure"); } : undefined,
    }));
    expect(calls).toBe(1); expect(error.code).toBe("observer_error");
    expect(error.accounting.costUsd).toBe(0.001);
  }
});

test("a pending observer can stop dispatch without inventing an outbound attempt", async () => {
  for (const earlierAttempt of [false, true]) {
    let calls = 0;
    const error = await rejected(evaluate(payload, {
      apiKey: "fixture-only",
      wait: async () => {},
      fetcher: (async () => {
        calls++;
        return Response.json(reply(), { status: 503 });
      }) as typeof fetch,
      onAccounting: accounting => {
        if (accounting.attempts.length === (earlierAttempt ? 2 : 1) &&
            accounting.attempts.at(-1)?.status === "pending")
          throw Error("Authored pre-dispatch observer failure");
      },
    }));
    expect(error.code).toBe("observer_error");
    expect(calls).toBe(earlierAttempt ? 1 : 0);
    expect(error.accounting.attempts).toHaveLength(calls);
    expect(error.accounting.costUsd).toBe(earlierAttempt ? 0.001 : 0);
    expect(accountingIssue(error.accounting)).toBeNull();
  }
  const controller = new AbortController();
  let calls = 0;
  const error = await rejected(evaluate(payload, {
    apiKey: "fixture-only", signal: controller.signal,
    fetcher: (async () => { calls++; return Response.json(reply()); }) as typeof fetch,
    onAccounting: () => controller.abort(),
  }));
  expect(error.code).toBe("cancelled");
  expect(calls).toBe(0);
  expect(error.accounting).toMatchObject({ attempts: [], costUsd: 0 });
});

test("real loopback HTTP redirects never reach the redirected target", async () => {
  let starts = 0, targets = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (new URL(request.url).pathname === "/start") {
      starts++; return new Response(null, { status: 307, headers: { location: "/target" } });
    }
    targets++; return Response.json(reply());
  } });
  try {
    const error = await rejected(evaluate(payload, { apiKey: "fixture-only", maxAttempts: 1,
      fetcher: ((_url, init) => fetch(new URL("/start", server.url), init)) as typeof fetch }));
    expect(starts).toBe(1); expect(targets).toBe(0);
    expect(error.accounting.attempts).toHaveLength(1); expect(error.accounting.costUsd).toBeNull();
  } finally { await server.stop(true); }
});
