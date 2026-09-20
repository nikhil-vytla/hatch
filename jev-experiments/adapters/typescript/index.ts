import * as z from "zod";
export type Question = {
  type: "choice" | "noul" | "score";
  instructions: string;
  criteria?: Record<string, string> | string[];
};
export type Answer = {
  type: "choice" | "noul" | "score";
  value: string | number;
  probabilities: Record<string, number> | null;
  confidence: number | null;
};
type Schema = Record<string, any>;
export type Transport = (
  state: unknown,
  questions: Record<string, Question>,
) => Promise<Record<string, Answer>>;

function resolve(
  schema: Schema,
  root: Schema,
  seen = new Set<string>(),
): Schema {
  if (!schema.$ref) return schema;
  const ref = String(schema.$ref);
  if (!ref.startsWith("#/") || seen.has(ref))
    throw Error("Only acyclic local references are supported");
  seen.add(ref);
  const target = ref
    .slice(2)
    .split("/")
    .map((x) => x.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((obj, key) => obj?.[key], root);
  if (!target) throw Error("Unresolved schema reference");
  return {
    ...resolve(target, root, seen),
    ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$ref")),
  };
}
export function compile(root: Schema): Record<string, Question> {
  const questions: Record<string, Question> = Object.create(null);
  const visit = (raw: Schema, path: string[], depth = 0) => {
    if (depth > 12) throw Error("Schema nesting exceeds 12 levels");
    const schema = resolve(raw, root),
      id = path.join(".");
    if (schema.type === "object") {
      if (!schema.properties || Object.keys(schema.properties).length === 0)
        throw Error("Empty objects are not decisions");
      for (const [key, value] of Object.entries(schema.properties)) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
          ["__proto__", "constructor", "prototype"].includes(key)
        )
          throw Error("Unsafe field name");
        if (!schema.required?.includes(key))
          throw Error(`Optional fields are unsupported: ${key}`);
        visit(value as Schema, [...path, key], depth + 1);
      }
      return;
    }
    if (
      !id ||
      typeof schema.description !== "string" ||
      !schema.description.trim()
    )
      throw Error(`A semantic description is required: ${id}`);
    if (
      schema.type === "string" &&
      Array.isArray(schema.enum) &&
      schema.enum.length >= 2 &&
      schema.enum.length <= 255 &&
      schema.enum.every((v: unknown) => typeof v === "string")
    )
      questions[id] = {
        type: "choice",
        instructions: schema.description,
        criteria: Object.fromEntries(
          schema.enum.map((x: string) => [x, x.replaceAll("_", " ")]),
        ),
      };
    else if (
      schema.type === "boolean" ||
      (schema.type === "number" && schema.minimum === 0 && schema.maximum === 1)
    )
      questions[id] = { type: "noul", instructions: schema.description };
    else if (
      schema.type === "number" &&
      Array.isArray(schema["x-jev-levels"]) &&
      schema["x-jev-levels"].length >= 2 &&
      schema.minimum === 0 &&
      schema.maximum === schema["x-jev-levels"].length - 1
    )
      questions[id] = {
        type: "score",
        instructions: schema.description,
        criteria: schema["x-jev-levels"],
      };
    else
      throw Error(
        `Unsupported semantic type at ${id}. Use a finite enum, boolean, probability, or explicit score rubric.`,
      );
  };
  visit(root, []);
  return questions;
}
export function decode(root: Schema, answers: Record<string, Answer>): unknown {
  const questions = compile(root);
  for (const [id, q] of Object.entries(questions)) {
    const a = answers[id];
    if (!a || a.type !== q.type)
      throw Error(`Missing or wrong answer type: ${id}`);
    if (q.type === "choice" && !(String(a.value) in q.criteria!))
      throw Error(`Unknown option: ${id}`);
    if (
      q.type !== "choice" &&
      (typeof a.value !== "number" ||
        !Number.isFinite(a.value) ||
        a.value < 0 ||
        a.value > (q.type === "noul" ? 1 : (q.criteria as string[]).length - 1))
    )
      throw Error(`Out of range: ${id}`);
    if (a.probabilities) {
      const expected =
        q.type === "choice"
          ? Object.keys(q.criteria!)
          : q.type === "score"
            ? (q.criteria as string[]).map((_, i) => String(i))
            : [];
      const entries = Object.entries(a.probabilities);
      if (
        entries.length !== expected.length ||
        entries.some(
          ([k, v]) =>
            !expected.includes(k) || !Number.isFinite(v) || v < 0 || v > 1,
        ) ||
        Math.abs(entries.reduce((s, [, v]) => s + v, 0) - 1) > 0.025
      )
        throw Error(`Malformed probabilities: ${id}`);
    }
    if (
      a.confidence !== null &&
      (!Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1)
    )
      throw Error(`Invalid confidence: ${id}`);
  }
  const visit = (raw: Schema, path: string[]): unknown => {
    const schema = resolve(raw, root);
    if (schema.type === "object")
      return Object.fromEntries(
        Object.entries(schema.properties).map(([k, v]) => [
          k,
          visit(v as Schema, [...path, k]),
        ]),
      );
    const a = answers[path.join(".")];
    return schema.type === "boolean" ? Number(a.value) >= 0.5 : a.value;
  };
  return visit(root, []);
}
export async function decide<T extends z.ZodType>(
  schema: T,
  state: unknown,
  transport: Transport,
): Promise<{
  value: z.output<T>;
  answers: Record<string, Answer>;
  questions: Record<string, Question>;
}> {
  const json = z.toJSONSchema(schema),
    questions = compile(json),
    answers = await transport(state, questions);
  return { value: schema.parse(decode(json, answers)), answers, questions };
}
export const loopback: Transport = async (state, questions) => {
  const response = await fetch("http://127.0.0.1:8792/api/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ state, questions }),
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.detail ?? `HTTP ${response.status}`);
  return body.answers;
};
