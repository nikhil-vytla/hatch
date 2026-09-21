import { expect, test } from "bun:test";
import { executeHttp } from "./http-executor";
import type { Route, Task } from "./types";
const route: Route = {
  id: "fixture",
  model: "configured",
  available: true,
  local: true,
  capabilities: ["text"],
  tools: [],
  contextTokens: 4096,
  maxOutputTokens: 128,
  quality: { value: 0.5, basis: "simulation", evidence: "test" },
  latencyMs: { value: 1, basis: "simulation", evidence: "test" },
  pricing: {
    inputPerMillion: 2,
    outputPerMillion: 4,
    cachedInputPerMillion: 1,
    basis: "configured",
    evidence: "test",
  },
  destination: { kind: "openai-compatible", endpoint: "http://127.0.0.1:1" },
};
const task: Task = {
  id: "test",
  prompt: "Respond",
  context: "Synthetic",
  outputTokens: 128,
};
const response = (
  usage: unknown,
  content = '{"kind":"answer","text":"ok"}',
) => ({ model: route.model, usage, choices: [{ message: { content } }] });
const fetcher = (body: unknown) =>
  (async () => Response.json(body)) as unknown as typeof fetch;
test("null and primitive HTTP bodies are malformed, never availability failures", async () => {
  for (const body of [null, 42, [], true]) {
    const result = await executeHttp(route, task, {
      outputTokens: 128,
      fetcher: fetcher(body),
    });
    expect(result.status).toBe("malformed");
    expect(result.rawOutput).toBe(JSON.stringify(body));
  }
});
test("shared HTTP path rejects negative usage and never calculates a negative charge", async () => {
  const result = await executeHttp(route, task, {
    outputTokens: 128,
    fetcher: fetcher(response({ prompt_tokens: -10, completion_tokens: 1 })),
  });
  expect(result.status).toBe("ok");
  expect(result.usage).toBeNull();
  expect(result.costUsd).toBeNull();
  expect(result.actualModel).toBe(route.model);
  expect(result.identityBasis).toBe("provider-reported");
});
test("cached usage is capped by total input and web accounting stays explicitly unknown", async () => {
  const fixture = fetcher(
    response({
      prompt_tokens: 10,
      completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 100 },
    }),
  );
  const cli = await executeHttp(route, task, {
      outputTokens: 128,
      fetcher: fixture,
    }),
    web = await executeHttp(route, task, {
      outputTokens: 128,
      fetcher: fixture,
      costAccounting: "unknown",
    });
  expect(cli.usage).toEqual({
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 10,
  });
  expect(cli.costUsd).toBeCloseTo(0.000018, 10);
  expect(web.usage).toEqual(cli.usage);
  expect(web.costUsd).toBeNull();
});
test("shared transport prohibits redirect following and sends the same strict artifact schema", async () => {
  let called = false;
  const result = await executeHttp(route, task, {
    outputTokens: 128,
    credential: "synthetic-test-key",
    fetcher: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      called = true;
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer synthetic-test-key",
      });
      const body = JSON.parse(String(init?.body));
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.max_tokens).toBe(128);
      return Response.json(
        response({ prompt_tokens: 1, completion_tokens: 1 }, "bad artifact"),
      );
    }) as unknown as typeof fetch,
  });
  expect(called).toBe(true);
  expect(result.status).toBe("malformed");
  expect(result.rawOutput).toBe("bad artifact");
  expect(result.artifact).toBeUndefined();
});
test("cancelled HTTP response cannot return a usable artifact", async () => {
  const abort = new AbortController();
  const result = await executeHttp(route, task, {
    outputTokens: 128,
    signal: abort.signal,
    fetcher: (async () => {
      abort.abort();
      return Response.json(
        response({ prompt_tokens: 1, completion_tokens: 1 }),
      );
    }) as unknown as typeof fetch,
  });
  expect(result.status).toBe("cancelled");
  expect(result.artifact).toBeUndefined();
});

test("a different provider-reported model is rejected with observed usage and unknown charge", async () => {
  const result = await executeHttp(route, task, {
    outputTokens: 128,
    fetcher: fetcher({
      ...response({ prompt_tokens: 10, completion_tokens: 2 }),
      model: "actual",
    }),
  });
  expect(result.status).toBe("error");
  expect(result.actualModel).toBe("actual");
  expect(result.identityBasis).toBe("provider-reported");
  expect(result.usage).toEqual({
    inputTokens: 10,
    outputTokens: 2,
    cachedInputTokens: 0,
  });
  expect(result.costUsd).toBeNull();
  expect(result.artifact).toBeUndefined();
  expect(result.error).toContain("does not match");
});

test("absent HTTP model metadata stays explicitly configured-unverified", async () => {
  const body = response({ prompt_tokens: 10, completion_tokens: 2 });
  const { model: _, ...unattested } = body;
  const result = await executeHttp(route, task, {
    outputTokens: 128,
    fetcher: fetcher(unattested),
  });
  expect(result.status).toBe("ok");
  expect(result.actualModel).toBe(route.model);
  expect(result.identityBasis).toBe("configured-unverified");
});
