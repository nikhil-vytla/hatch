import { test, expect } from "bun:test";
import { apiKeyFromHeader, evaluate } from "./gateway";
import evaluateHandler from "../api/evaluate";
import composeHandler from "../api/compose";
const payload = {
  state: "hello",
  questions: {
    greeting: { type: "noul" as const, instructions: "Is this a greeting?" },
  },
};
const response = () => ({
  code: 200,
  body: null as any,
  chunks: [] as string[],
  headers: {} as Record<string, string>,
  setHeader(k: string, v: string) {
    this.headers[k] = v;
  },
  status(n: number) {
    this.code = n;
    return this;
  },
  json(body: any) {
    this.body = body;
    return this;
  },
  on() {},
  write(chunk: string) {
    this.chunks.push(chunk);
  },
  end() {},
});
test("missing or malformed credentials never borrow environment credentials", async () => {
  const prior = process.env.AI_GATEWAY_API_KEY;
  process.env.AI_GATEWAY_API_KEY = "must-never-be-used";
  try {
    for (const header of [
      undefined,
      null,
      ["Bearer key"],
      "key",
      "Bearer ",
      "Bearer key\nother",
      "Bearer key other",
      "Bearer " + "a".repeat(8193),
    ]) {
      expect(apiKeyFromHeader(header)).toBe("");
      for (const handler of [evaluateHandler, composeHandler]) {
        const res = response();
        await handler(
          { method: "POST", headers: { authorization: header }, body: payload },
          res,
        );
        expect(res.code).toBe(401);
        expect(res.headers["Cache-Control"]).toBe("no-store");
      }
    }
    await expect(
      evaluate(payload, {
        apiKey: "",
        fetcher: (() => {
          throw new Error("must not fetch");
        }) as any,
      }),
    ).rejects.toMatchObject({ status: 401 });
  } finally {
    if (prior === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = prior;
  }
});
test("concurrent callers retain their own keys through evaluation and composition", async () => {
  const original = globalThis.fetch,
    seen: string[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    expect(String(url)).toBe(
      "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    );
    seen.push(init.headers.Authorization);
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.model).toBe("typesafe-ai/jev");
    await Bun.sleep(1);
    return Response.json({
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([id, q]: any) => [
          id,
          q.type === "choice"
            ? {
                type: "choice",
                probabilities: Object.fromEntries(Object.keys(q.criteria).map(key => [key, key === (Object.hasOwn(q.criteria, "finish") ? "finish" : Object.keys(q.criteria)[0]) ? 1 : 0])),
                choice: Object.hasOwn(q.criteria, "finish")
                  ? "finish"
                  : Object.keys(q.criteria)[0],
              }
            : { type: "noul", noul: 0.9 },
        ]),
      ),
    });
  }) as typeof fetch;
  try {
    const a = response(),
      b = response(),
      c = response();
    await Promise.all([
      evaluateHandler(
        {
          method: "POST",
          headers: { authorization: "Bearer caller-a" },
          body: payload,
        },
        a,
      ),
      evaluateHandler(
        {
          method: "POST",
          headers: { authorization: "Bearer caller-b" },
          body: payload,
        },
        b,
      ),
      composeHandler(
        {
          method: "POST",
          headers: { authorization: "Bearer caller-c" },
          body: { prompt: "Finish", domain: "settings" },
        },
        c,
      ),
    ]);
    expect(a.code).toBe(200);
    expect(b.code).toBe(200);
    for (const key of ["a", "b", "c"])
      expect(seen).toContain(`Bearer caller-${key}`);
    expect(
      seen.every((value) =>
        ["Bearer caller-a", "Bearer caller-b", "Bearer caller-c"].includes(
          value,
        ),
      ),
    ).toBe(true);
    expect(c.chunks.join("")).not.toContain('"type":"error"');
    expect(JSON.stringify([a.body, b.body, c.chunks])).not.toMatch(
      /caller-[abc]/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("provider fields and oversized UTF-8 input fail before a provider request", async () => {
  let calls = 0;
  for (const body of [
    { ...payload, model: "other/model" },
    { ...payload, gateway: { anything: true } },
    { ...payload, questions: [] },
    {
      ...payload,
      questions: { x: { ...payload.questions.greeting, apiKey: "secret" } },
    },
    { ...payload, state: "😀".repeat(26000) },
  ])
    await expect(
      evaluate(body as any, {
        apiKey: "caller-key",
        fetcher: (async () => {
          calls++;
          throw new Error("must not fetch");
        }) as any,
      }),
    ).rejects.toMatchObject({ status: 400 });
  expect(calls).toBe(0);
});
test("provider rejection bodies are not exposed or retried", async () => {
  let calls = 0;
  try {
    await evaluate(payload, {
      apiKey: "caller-key",
      fetcher: (async () => {
        calls++;
        return new Response("secret provider echo", { status: 401 });
      }) as any,
    });
    throw new Error("Expected rejection");
  } catch (error: any) {
    expect(error.status).toBe(401);
    expect(error.message).not.toContain("secret provider echo");
    expect(error.message).toContain("API key");
  }
  expect(calls).toBe(1);
});
