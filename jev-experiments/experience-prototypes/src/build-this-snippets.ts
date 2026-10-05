/**
 * "Build this": runnable code that reproduces a request a scene sent to Jev, generated from the
 * scene's real request object. Three forms:
 *
 * - The TypeSafe Python SDK (`typesafe-sdk`): `TypeSafeClient(api_key=, base_url=, model=)` and
 *   `client.system_one(state=, questions=)`, which accepts plain dict questions.
 *   https://docs.typesafe.ai/sdk/python and /sdk/python/api/clients/sync
 * - The TypeSafe JavaScript SDK (`@typesafe-ai/sdk`): `new TypeSafeClient({ apiKey, baseURL,
 *   defaultModel })` and `client.systemOne({ state, questions })`, which posts to
 *   `${baseURL}/v1/systemone`. https://docs.typesafe.ai/sdk/javascript
 * - The HTTP call this site's server makes (packages/jev-client): POST to the Vercel AI Gateway's
 *   TypeSafe route with model "typesafe-ai/jev". https://docs.typesafe.ai/api
 *
 * The key always comes from AI_GATEWAY_API_KEY in the environment; no snippet contains a key.
 */
import { JEV_GATEWAY_BASE_URL, JEV_GATEWAY_URL, JEV_MODEL } from "../../packages/jev-client/src/wire";


export const DOCS = {
  python: "https://docs.typesafe.ai/sdk/python",
  javascript: "https://docs.typesafe.ai/sdk/javascript",
  http: "https://docs.typesafe.ai/api",
} as const;

export type QuestionType = "noul" | "choice" | "score";
export type JevQuestion = { type: QuestionType; instructions: unknown; criteria?: unknown };
export type JevRequest = { state: unknown; questions: Record<string, JevQuestion> };
export type NamedRequest = { name: string; request: JevRequest };

const TYPES = new Set(["noul", "choice", "score"]);

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** The typed request in `x`, if it is one: a state and a non-empty map of noul, choice or score questions. */
export function asJevRequest(x: unknown): JevRequest | null {
  if (!isObject(x) || !("state" in x) || !isObject(x.questions)) return null;

  const qs = Object.values(x.questions);

  if (!qs.length || !qs.every((q) => isObject(q) && typeof q.type === "string" && TYPES.has(q.type))) return null;

  // SAFETY: every question was just checked to be an object with a noul, choice or score type.
  return { state: x.state, questions: x.questions as Record<string, JevQuestion> };
}

/**
 * Every typed request found in what a scene stored as "the request": one request, a list of them
 * (a batched run), or a map of named ones (e.g. an answer and a referee).
 */
export function collectRequests(x: unknown, name = "request"): NamedRequest[] {
  const one = asJevRequest(x);

  if (one) return [{ name, request: one }];

  if (Array.isArray(x)) return x.flatMap((v, i) => collectRequests(v, `${name} ${i + 1}`));

  if (isObject(x)) return Object.entries(x).flatMap(([k, v]) => (asJevRequest(v) ? [{ name: k, request: asJevRequest(v) as JevRequest }] : []));

  return [];
}

/** How many requests a snippet writes out in full; the rest are described, not repeated. */
export const MAX_SHOWN = 2;

const pyIdent = (name: string, i: number) => {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  return id && /^[a-z_]/.test(id) ? id : `request_${i + 1}`;
};

/** A JSON value as a Python literal: dicts, lists, str, int/float, True/False/None. */
export function toPython(value: unknown, indent = 0): string {
  const pad = (n: number) => " ".repeat(n);

  if (value === null || value === undefined) return "None";

  if (value === true) return "True";

  if (value === false) return "False";

  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "None";

  // JSON string escapes (\n, \", \uXXXX) are valid Python string escapes.
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (!value.length) return "[]";

    return `[\n${value.map((v) => pad(indent + 4) + toPython(v, indent + 4)).join(",\n")},\n${pad(indent)}]`;
  }

  if (isObject(value)) {
    const entries = Object.entries(value);

    if (!entries.length) return "{}";

    return `{\n${entries.map(([k, v]) => `${pad(indent + 4)}${JSON.stringify(k)}: ${toPython(v, indent + 4)}`).join(",\n")},\n${pad(indent)}}`;
  }

  return "None";
}

/** A JSON value as a TypeScript literal, indented to sit inside the call. */
const toTs = (value: unknown, indent: number) => JSON.stringify(value ?? null, null, 2).replace(/\n/g, `\n${" ".repeat(indent)}`);

const ANSWER_FIELD: Record<QuestionType, { py: string; field: string }> = {
  noul: { py: "nouls", field: "noul" },
  choice: { py: "choices", field: "choice" },
  score: { py: "scores", field: "score" },
};

/** Accessor lines for a request's answers: at most this many, then a count. */
const MAX_PRINTS = 4;

function remainder(n: number, comment: string) {
  return n > MAX_SHOWN ? [`${comment} …and ${n - MAX_SHOWN} more request${n - MAX_SHOWN === 1 ? "" : "s"} like ${n > MAX_SHOWN + 1 ? "these" : "this"}, one per batch.`] : [];
}

export function pythonSnippet(requests: NamedRequest[]): string {
  const shown = requests.slice(0, MAX_SHOWN);
  const lines = [
    "# pip install typesafe-sdk",
    "import os",
    "",
    "from typesafe_sdk import TypeSafeClient",
    "",
    "# Through the Vercel AI Gateway, as this site does. With a TypeSafe key, set",
    "# TYPESAFE_API_KEY and drop api_key, base_url and model.",
    "with TypeSafeClient(",
    '    api_key=os.environ["AI_GATEWAY_API_KEY"],',
    `    base_url=${JSON.stringify(JEV_GATEWAY_BASE_URL)},`,
    `    model=${JSON.stringify(JEV_MODEL)},`,
    ") as client:",
  ];

  shown.forEach(({ name, request }, i) => {
    const v = shown.length === 1 ? "response" : pyIdent(name, i);

    if (i) lines.push("");

    lines.push(
      `    ${v} = client.system_one(`,
      `        state=${toPython(request.state, 8)},`,
      `        questions=${toPython(request.questions, 8)},`,
      "    )",
    );

    const ids = Object.entries(request.questions);

    for (const [id, q] of ids.slice(0, MAX_PRINTS)) lines.push(`    print(${v}.${ANSWER_FIELD[q.type].py}[${JSON.stringify(id)}].${ANSWER_FIELD[q.type].field})`);

    if (ids.length > MAX_PRINTS) lines.push(`    # …${ids.length - MAX_PRINTS} more answers in ${v}.nouls, .choices and .scores`);
  });

  lines.push(...remainder(requests.length, "    #"));

  return `${lines.join("\n")}\n`;
}

export function typescriptSnippet(requests: NamedRequest[]): string {
  const shown = requests.slice(0, MAX_SHOWN);
  const lines = [
    "// npm install @typesafe-ai/sdk",
    'import { TypeSafeClient } from "@typesafe-ai/sdk";',
    "",
    "// Through the Vercel AI Gateway, as this site does. With a TypeSafe key, set",
    "// TYPESAFE_API_KEY and drop apiKey, baseURL and defaultModel.",
    "const client = new TypeSafeClient({",
    "  apiKey: process.env.AI_GATEWAY_API_KEY,",
    `  baseURL: ${JSON.stringify(JEV_GATEWAY_BASE_URL)},`,
    `  defaultModel: ${JSON.stringify(JEV_MODEL)},`,
    "});",
  ];

  shown.forEach(({ name, request }, i) => {
    const v = shown.length === 1 ? "response" : pyIdent(name, i).replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

    lines.push(
      "",
      `const ${v} = await client.systemOne({`,
      `  state: ${toTs(request.state, 2)},`,
      `  questions: ${toTs(request.questions, 2)},`,
      "});",
    );

    const ids = Object.entries(request.questions);

    for (const [id, q] of ids.slice(0, MAX_PRINTS)) lines.push(`console.log(${v}.answers[${JSON.stringify(id)}].${ANSWER_FIELD[q.type].field});`);

    if (ids.length > MAX_PRINTS) lines.push(`// …${ids.length - MAX_PRINTS} more answers in ${v}.answers`);
  });

  lines.push(...remainder(requests.length, "//"));

  return `${lines.join("\n")}\n`;
}

/** The body this site's server sends to the gateway for one request. */
export const gatewayBody = (r: JevRequest) => ({ model: JEV_MODEL, state: r.state, questions: r.questions });

export function curlSnippet(requests: NamedRequest[]): string {
  const shown = requests.slice(0, MAX_SHOWN);
  const blocks = shown.map(({ request }) =>
    [
      `curl ${JEV_GATEWAY_URL} \\`,
      '  -H "Authorization: Bearer $AI_GATEWAY_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      "  --data @- <<'JSON'",
      JSON.stringify(gatewayBody(request), null, 2),
      "JSON",
    ].join("\n"),
  );

  return `${["# The exact call this site's server makes.", ...blocks].join("\n\n")}${requests.length > MAX_SHOWN ? `\n\n${remainder(requests.length, "#")[0]}` : ""}\n`;
}

/** The JSON bodies inside a curl snippet (between the heredoc markers), for checking. */
export function curlBodies(snippet: string): string[] {
  return [...snippet.matchAll(/<<'JSON'\n([\s\S]*?)\nJSON(?:\n|$)/g)].map((m) => m[1]);
}

/** Studies the decide CLI (tools/decide-cli) can run end to end. */
export type CliStudy = "fool" | "suggestion" | "decoy";

export function cliSnippet(study: CliStudy): string {
  return [
    "# From jev-experiments/ in this repository. --dry-run prints the requests and the",
    "# worst-case cost without sending anything; drop it to run on your key.",
    `bun tools/decide-cli/cli.ts eval ${study} --endpoint jev --dry-run`,
    `AI_GATEWAY_API_KEY=… bun tools/decide-cli/cli.ts eval ${study} --endpoint jev --max-usd 0.05 --out ${study}.jsonl`,
    `bun tools/decide-cli/cli.ts report ${study}.jsonl`,
    "",
  ].join("\n");
}

/** Just the answers from a recorded or live response, for "what comes back". */
export function expectedAnswers(response: unknown): unknown {
  if (Array.isArray(response)) return response.slice(0, MAX_SHOWN).map(expectedAnswers);

  if (isObject(response) && isObject(response.answers)) return { answers: response.answers };

  return response ?? null;
}
