/**
 * A deterministic stand-in for SGLang's /v1/systemone, for trying `jev-lab` with no
 * key and no GPU. Answers are a hash of the question, not a model: use it to exercise the plumbing,
 * never as a result.
 */
const hash = (s: string) => {
  let h = 2166136261;

  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;

  return h / 4294967296;
};

type Question = { type: string; instructions?: string; criteria?: Record<string, string> | string[] };

export function mockAnswer(q: Question) {
  const h = hash(JSON.stringify(q));

  if (q.type === "noul") return { type: "noul", noul: 0.05 + 0.9 * h };

  const keys = q.type === "choice" ? Object.keys((q.criteria ?? {}) as Record<string, string>) : ((q.criteria ?? []) as string[]).map((_, i) => String(i));
  const raw = keys.map((k) => 0.1 + hash(k + h));
  const z = raw.reduce((a, b) => a + b, 0);
  const probabilities = Object.fromEntries(keys.map((k, i) => [k, raw[i]! / z]));
  const top = keys.reduce((a, b) => (probabilities[b]! > probabilities[a]! ? b : a), keys[0]!);

  return q.type === "choice" ? { type: "choice", choice: top, probabilities } : { type: "score", score: Number(top), probabilities };
}

/** `failWith` fails every request with that status, or only the first `failTimes` requests. */
export type MockOptions = { port?: number; failWith?: number; failTimes?: number; latencyMs?: number };

export function serveMock(opts: MockOptions = {}) {
  let requests = 0;

  return Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/health") return Response.json({ ok: true, model: "mock" });

      if (url.pathname !== "/v1/systemone" || req.method !== "POST") return new Response("not found", { status: 404 });

      if (opts.failWith && ++requests <= (opts.failTimes ?? Infinity)) return new Response(JSON.stringify({ error: "mock failure" }), { status: opts.failWith });

      const body = (await req.json()) as { questions: Record<string, Question> };

      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));

      const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, mockAnswer(q)]));

      return Response.json({ model: "mock (hash, not a model)", answers, usage: { input_tokens: Math.ceil(JSON.stringify(body).length / 4) } });
    },
  });
}
