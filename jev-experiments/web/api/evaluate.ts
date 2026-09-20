import { timingSafeEqual } from "node:crypto";

type Req = {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};
type Res = {
  status(n: number): Res;
  json(x: unknown): void;
  setHeader(k: string, v: string): void;
};
let inflight = 0;
let windowStart = Date.now();
let attempts = 0;

export default async function handler(req: Req, res: Res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const expected = process.env.LAB_ACCESS_TOKEN;
  const provided = String(req.headers.authorization || "").replace(
    /^Bearer /,
    "",
  );
  if (
    !expected ||
    Buffer.byteLength(expected) !== Buffer.byteLength(provided) ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
  ) {
    return res.status(401).json({
      error:
        "Live runs need the private lab access token. Recorded experiments are public.",
    });
  }
  if (Date.now() - windowStart > 600_000) {
    windowStart = Date.now();
    attempts = 0;
  }
  if (inflight >= 2 || attempts >= 80)
    return res
      .status(429)
      .json({ error: "This function instance is busy. Try again shortly." });
  const body = req.body as {
    state?: unknown;
    questions?: Record<
      string,
      { type: string; instructions: string; criteria?: unknown }
    >;
  };
  if (
    !body ||
    JSON.stringify(body).length > 80_000 ||
    body.state === undefined ||
    !body.questions ||
    Object.keys(body.questions).length < 1 ||
    Object.keys(body.questions).length > 128
  ) {
    return res
      .status(400)
      .json({ error: "Supply state and 1–128 questions, under 80 KB." });
  }
  for (const q of Object.values(body.questions)) {
    if (
      !q ||
      !["choice", "noul", "score"].includes(q.type) ||
      typeof q.instructions !== "string" ||
      q.instructions.length < 1 ||
      q.instructions.length > 8000
    )
      return res.status(400).json({ error: "Invalid question" });
    if (
      q.type === "choice" &&
      (!q.criteria ||
        Array.isArray(q.criteria) ||
        typeof q.criteria !== "object" ||
        Object.keys(q.criteria).length < 2 ||
        Object.keys(q.criteria).length > 255 ||
        Object.values(q.criteria).some((v) => typeof v !== "string"))
    )
      return res.status(400).json({ error: "Invalid choice options" });
    if (
      q.type === "score" &&
      (!Array.isArray(q.criteria) ||
        q.criteria.length < 2 ||
        q.criteria.length > 255 ||
        q.criteria.some((v) => typeof v !== "string"))
    )
      return res.status(400).json({ error: "Invalid score rubric" });
    if (q.type === "noul" && q.criteria !== undefined)
      return res
        .status(400)
        .json({ error: "Noul does not take criteria here" });
  }
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key)
    return res.status(503).json({ error: "Live gateway is not configured" });
  attempts++;
  inflight++;
  const start = performance.now();
  try {
    const response = await fetch(
      "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "typesafe-ai/jev",
          state: body.state,
          questions: body.questions,
        }),
        signal: AbortSignal.timeout(55_000),
      },
    );
    if (!response.ok)
      return res.status(response.status).json({
        error: `Gateway returned HTTP ${response.status}. This run was not completed.`,
      });
    const raw = await response.json();
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const a = raw.answers?.[id];
      const value = a?.[q.type];
      if (
        !a ||
        a.type !== q.type ||
        (q.type === "choice" &&
          !Object.hasOwn(q.criteria as object, String(value))) ||
        (q.type !== "choice" &&
          (typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0 ||
            value >
              (q.type === "noul" ? 1 : (q.criteria as string[]).length - 1)))
      )
        throw new Error("Invalid provider answer");
      if (a.probabilities != null) {
        const expected =
          q.type === "choice"
            ? Object.keys(q.criteria as object)
            : q.type === "score"
              ? (q.criteria as string[]).map((_, i) => String(i))
              : [];
        const entries = Object.entries(a.probabilities) as [string, unknown][];
        if (
          entries.length !== expected.length ||
          entries.some(
            ([k, p]) =>
              !expected.includes(k) ||
              typeof p !== "number" ||
              !Number.isFinite(p) ||
              p < 0 ||
              p > 1,
          ) ||
          Math.abs(entries.reduce((sum, [, p]) => sum + Number(p), 0) - 1) >
            0.025
        )
          throw new Error("Invalid provider answer");
      }
      if (
        a.confidence != null &&
        (typeof a.confidence !== "number" ||
          !Number.isFinite(a.confidence) ||
          a.confidence < 0 ||
          a.confidence > 1)
      )
        throw new Error("Invalid provider answer");
      answers[id] = {
        type: a.type,
        value,
        probabilities: a.probabilities ?? null,
        confidence: a.confidence ?? null,
      };
    }
    return res.status(200).json({
      answers,
      latency_ms: performance.now() - start,
      cost_usd: raw.provider_metadata?.gateway?.cost ?? null,
      model: raw.model,
      raw,
    });
  } catch (error) {
    return res.status(502).json({
      error:
        error instanceof Error && error.message === "Invalid provider answer"
          ? error.message
          : "Gateway request failed or timed out",
    });
  } finally {
    inflight--;
  }
}
