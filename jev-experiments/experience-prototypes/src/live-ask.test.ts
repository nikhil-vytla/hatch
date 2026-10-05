import { beforeEach, describe, expect, test } from "bun:test";
import { createLiveAsk } from "./live-ask";
import { USD_PER_INPUT_TOKEN } from "./receipt";
import { resetSession, sessionUsage } from "./session-meter";

const REQ = { state: { text: "hi" }, questions: { q: { type: "noul", instructions: "?" } } };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));

  return { promise, resolve };
}

/** A fake fetch: each call takes the next scripted reply, and is recorded with its signal. */
function fakeFetch(replies: (() => Promise<Response> | Response)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = replies.shift();

    if (!reply) throw new Error("unscripted fetch");

    return reply();
  }) as unknown as typeof globalThis.fetch;

  return { fetch, calls };
}

const answer = (tokens = 100, extra: object = {}) => Response.json({ answers: { q: { value: 0.7 } }, usage: { input_tokens: tokens }, latency_ms: 12, served_by: "fake", ...extra });

const ndjson = (events: unknown[]) =>
  new Response(events.map((e) => JSON.stringify(e)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });

const key = () => "test-key";

beforeEach(() => resetSession());

describe("live ask", () => {
  test("no key: nothing is sent, and the status is the shared no-key failure", async () => {
    const f = fakeFetch([]);
    const live = createLiveAsk({ fetch: f.fetch, key: () => "" });

    expect(await live.ask(REQ)).toBeUndefined();
    expect(f.calls).toHaveLength(0);
    expect(live.status).toMatchObject({ kind: "failed", failure: { kind: "no-key", title: "No key connected." } });
    expect(sessionUsage().calls).toBe(0);
  });

  test("an answer is returned with its receipt, sent with the visitor's key and metered once", async () => {
    const f = fakeFetch([() => answer(300)]);
    const live = createLiveAsk({ fetch: f.fetch, key });
    const body = await live.ask(REQ);

    expect(body.answers.q.value).toBe(0.7);
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(live.status.kind).toBe("done");
    expect(live.status.kind === "done" && live.status.receipt).toMatchObject({ mode: "live", ms: 12, inputTokens: 300, servedBy: "fake", raw: { request: REQ } });
    expect(sessionUsage()).toMatchObject({ calls: 1, failed: 0, inputTokens: 300 });
  });

  test("a superseded request is aborted, and its late answer never reaches the scene", async () => {
    const first = deferred<Response>();
    const f = fakeFetch([() => first.promise, () => answer(50, { answers: { q: { value: 0.2 } } })]);
    const live = createLiveAsk({ fetch: f.fetch, key });
    const old = live.ask(REQ);
    const fresh = live.ask(REQ);

    expect((f.calls[0].init.signal as AbortSignal).aborted).toBe(true);
    // A server that ignored the abort still answers; the answer is dropped.
    first.resolve(answer(999));
    expect(await old).toBeUndefined();
    expect((await fresh).answers.q.value).toBe(0.2);
    expect(live.status.kind === "done" && live.status.value.answers.q.value).toBe(0.2);
  });

  test("cancel (what unmounting does) aborts the request in flight and returns to idle", async () => {
    const reply = deferred<Response>();
    const f = fakeFetch([() => reply.promise]);
    const live = createLiveAsk({ fetch: f.fetch, key });
    const pending = live.ask(REQ);

    expect(live.status.kind).toBe("asking");
    live.cancel();
    expect((f.calls[0].init.signal as AbortSignal).aborted).toBe(true);
    expect(live.status.kind).toBe("idle");
    reply.resolve(answer());
    expect(await pending).toBeUndefined();
    expect(live.status.kind).toBe("idle");
  });

  test("a multi-call ask aborts every call it made when cancelled", async () => {
    const a = deferred<Response>(), b = deferred<Response>();
    const f = fakeFetch([() => a.promise, () => b.promise]);
    const live = createLiveAsk({ fetch: f.fetch, key });
    const pending = live.ask((jev) => Promise.all([jev.evaluate(REQ), jev.evaluate(REQ)]));

    await Promise.resolve();
    live.cancel();
    expect(f.calls.map((c) => (c.init.signal as AbortSignal).aborted)).toEqual([true, true]);
    a.resolve(answer());
    b.resolve(answer());
    expect(await pending).toBeUndefined();
  });

  test("429 reads as rate limited with the server's delay, counts as a failed call, and asking again works", async () => {
    const f = fakeFetch([() => Response.json({ error: "slow down", retry_after_ms: 5000 }, { status: 429 }), () => answer(10)]);
    const live = createLiveAsk({ fetch: f.fetch, key });
    const failures: string[] = [];

    expect(await live.ask(REQ, { onFailure: (x) => failures.push(x.kind) })).toBeUndefined();
    expect(live.status).toMatchObject({ kind: "failed", failure: { kind: "rate-limited", retryAfterMs: 5000, retryable: true } });
    expect(failures).toEqual(["rate-limited"]);
    expect(sessionUsage()).toMatchObject({ calls: 1, failed: 1, inputTokens: 0 });
    expect((await live.ask(REQ)).answers.q.value).toBe(0.7);
    expect(sessionUsage()).toMatchObject({ calls: 2, failed: 1, inputTokens: 10 });
  });

  test("5xx reads as unavailable, 401 from the gateway as a rejected key, a dropped connection as offline", async () => {
    const f = fakeFetch([
      () => Response.json({ error: "Jev is busy." }, { status: 503 }),
      () => Response.json({ error: "Vercel AI Gateway rejected this API key." }, { status: 401 }),
      () => Promise.reject(new TypeError("Failed to fetch")),
      () => new Response("<html>oops</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
    ]);
    const live = createLiveAsk({ fetch: f.fetch, key });
    const kinds = [];

    for (let i = 0; i < 4; i++) {
      await live.ask(REQ);
      kinds.push(live.status.kind === "failed" && live.status.failure.kind);
    }

    expect(kinds).toEqual(["unavailable", "bad-key", "offline", "unavailable"]);
    // The connection that never reached the server doesn't count.
    expect(sessionUsage()).toMatchObject({ calls: 3, failed: 3 });
  });

  test("queued asks keep one request in flight and run only the newest after it", async () => {
    const first = deferred<Response>();
    const f = fakeFetch([() => first.promise, () => answer(1, { answers: { q: { value: 0.9 } } })]);
    const live = createLiveAsk({ fetch: f.fetch, key });
    const a = live.ask(REQ, { whenBusy: "queue" });
    const b = live.ask({ ...REQ, state: { text: "b" } }, { whenBusy: "queue" });
    const c = live.ask({ ...REQ, state: { text: "c" } }, { whenBusy: "queue" });

    expect((f.calls[0].init.signal as AbortSignal).aborted).toBe(false);
    first.resolve(answer());
    expect((await a).answers.q.value).toBe(0.7);
    expect(await b).toBeUndefined();
    expect((await c).answers.q.value).toBe(0.9);
    expect(f.calls.map((x) => JSON.parse(String(x.init.body)).state.text)).toEqual(["hi", "c"]);
  });

  test("parallel asks run alongside each other; cancel aborts them all", async () => {
    const a = deferred<Response>(), b = deferred<Response>();
    const f = fakeFetch([() => a.promise, () => b.promise]);
    const live = createLiveAsk({ fetch: f.fetch, key });
    const one = live.ask(REQ, { whenBusy: "parallel" });
    const two = live.ask(REQ, { whenBusy: "parallel" });

    await Promise.resolve();
    expect(f.calls.map((c) => (c.init.signal as AbortSignal).aborted)).toEqual([false, false]);
    a.resolve(answer());
    expect((await one).answers.q.value).toBe(0.7);
    // One still in flight, so the ask is still asking.
    expect(live.status.kind).toBe("asking");
    live.cancel();
    expect((f.calls[1].init.signal as AbortSignal).aborted).toBe(true);
    b.resolve(answer());
    expect(await two).toBeUndefined();
  });

  test("a failed call in a multi-call ask aborts its siblings", async () => {
    const slow = deferred<Response>();
    const f = fakeFetch([() => slow.promise, () => Response.json({ error: "busy" }, { status: 503 })]);
    const live = createLiveAsk({ fetch: f.fetch, key });

    expect(await live.ask((jev) => Promise.all([jev.evaluate(REQ), jev.evaluate(REQ)]))).toBeUndefined();
    expect(live.status.kind === "failed" && live.status.failure.kind).toBe("unavailable");
    expect((f.calls[0].init.signal as AbortSignal).aborted).toBe(true);
  });

  test("hasKey sets the no-key failure for scenes that check before starting", () => {
    const live = createLiveAsk({ fetch: fakeFetch([]).fetch, key: () => "" });

    expect(live.hasKey()).toBe(false);
    expect(live.status).toMatchObject({ kind: "failed", failure: { kind: "no-key" } });
    expect(createLiveAsk({ key }).hasKey()).toBe(true);
  });

  test("a composition stream with N Jev calls adds N calls and their tokens to the meter", async () => {
    const steps = [120, 80, 200];
    const f = fakeFetch([
      () =>
        ndjson([
          ...steps.flatMap((t, i) => [
            { type: "call", ok: true, usage: { input_tokens: t }, latency_ms: 5 },
            { type: "step", spec: { root: "r" }, step: { index: i } },
          ]),
          { type: "complete", spec: { root: "r" }, stopReason: "finish" },
        ]),
    ]);
    const live = createLiveAsk({ fetch: f.fetch, key });
    const seen: string[] = [];

    await live.ask(async (jev) => {
      for await (const e of jev.compose({ prompt: "x" })) seen.push(e.type);
    });

    expect(f.calls[0].url).toBe("/api/compose");
    expect(seen).toEqual(["step", "step", "step", "complete"]);
    const total = steps.reduce((a, b) => a + b, 0);

    expect(sessionUsage()).toMatchObject({ calls: 3, failed: 0, inputTokens: total });
    expect(sessionUsage().costUsd).toBeCloseTo(total * USD_PER_INPUT_TOKEN, 12);
    expect(live.status.kind === "done" && live.status.receipt).toMatchObject({ inputTokens: total, questions: null });
  });

  test("a composition's error frame is classified like any other failure, and failed calls count", async () => {
    const f = fakeFetch([
      () =>
        ndjson([
          { type: "call", ok: true, usage: { input_tokens: 40 } },
          { type: "step", spec: {}, step: { index: 0 } },
          { type: "call", ok: false },
          { type: "error", error: "Jev is busy. Your input is preserved; retry shortly.", status: 503 },
        ]),
    ]);
    const live = createLiveAsk({ fetch: f.fetch, key });
    const seen: string[] = [];

    await live.ask(async (jev) => {
      for await (const e of jev.compose({ prompt: "x" })) seen.push(e.type);
    });

    expect(seen).toEqual(["step"]);
    expect(live.status).toMatchObject({ kind: "failed", failure: { kind: "unavailable" } });
    expect(sessionUsage()).toMatchObject({ calls: 2, failed: 1, inputTokens: 40 });
  });
});
