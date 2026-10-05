import { expect, test } from "bun:test";
import composeHandler from "../api/compose";
import { composeLines } from "./compose";

/** A fake gateway that finishes every composition, reporting `tokens` input tokens per call. */
function gateway(tokens: number, failAfter = Infinity) {
  let calls = 0;

  return (async (_url: string, init: RequestInit) => {
    if (++calls > failAfter) return new Response("{}", { status: 400 });
    const body = JSON.parse(String(init.body));

    return Response.json({
      usage: { input_tokens: tokens },
      answers: Object.fromEntries(
        Object.entries(body.questions).map(([id, q]: any) => {
          const keys = Object.keys(q.criteria);
          const pick = keys.includes("finish") && calls > 2 ? "finish" : keys.find((k) => k !== "finish") ?? keys[0];

          return [id, { type: "choice", choice: pick, probabilities: Object.fromEntries(keys.map((k) => [k, k === pick ? 1 : 0])) }];
        }),
      ),
    });
  }) as unknown as typeof fetch;
}

async function lines(fake: typeof fetch, body: unknown) {
  const original = globalThis.fetch;

  globalThis.fetch = fake;
  try {
    const out: any[] = [];

    for await (const line of composeLines(body, new AbortController().signal, "caller-key")) out.push(JSON.parse(line));

    return out;
  } finally {
    globalThis.fetch = original;
  }
}

test("every Jev call a composition makes is reported in the stream, before the event it led to", async () => {
  const events = await lines(gateway(70), { prompt: "A settings page", domain: "settings" });
  const calls = events.filter((e) => e.type === "call");
  const steps = events.filter((e) => e.type === "step");

  expect(events.at(-1).type).toBe("complete");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.ok && c.usage.input_tokens === 70)).toBe(true);
  // Each step was preceded by at least the call that chose it.
  expect(events.findIndex((e) => e.type === "call")).toBeLessThan(events.findIndex((e) => e.type === "step"));
  expect(calls.length).toBeGreaterThanOrEqual(steps.length);
});

test("a stopped composition ends with one error line carrying the gateway's status, after its calls", async () => {
  const events = await lines(gateway(10, 1), { prompt: "A settings page", domain: "settings" });

  expect(events.at(-1)).toEqual({ type: "error", error: "Gateway rejected the request (400).", status: 400 });
  expect(events.filter((e) => e.type === "call").map((e) => e.ok)).toEqual([true, false]);
});

test("invalid input is framed the same way", async () => {
  expect(await lines(gateway(1), { prompt: "" })).toEqual([{ type: "error", error: "Supply a prompt under 4000 characters.", status: 400 }]);
});

test("the Vercel function writes exactly the shared lines", async () => {
  const original = globalThis.fetch;
  const chunks: string[] = [];

  globalThis.fetch = gateway(5);
  try {
    await composeHandler(
      { method: "POST", headers: { authorization: "Bearer caller-key" }, body: { prompt: "x", domain: "settings" } },
      { setHeader() {}, status() { return this; }, json() {}, on() {}, write: (c: string) => chunks.push(c), end() {} },
    );
  } finally {
    globalThis.fetch = original;
  }

  const expected = (await lines(gateway(5), { prompt: "x", domain: "settings" })).map((e) => JSON.stringify(e) + "\n");

  expect(chunks.map((c) => JSON.parse(c).type)).toEqual(expected.map((c) => JSON.parse(c).type));
});
