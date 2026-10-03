/**
 * PROTOTYPE. Tool-call bouncer: reads an agent transcript (OpenAI or Anthropic tool-call JSON)
 * and flags tool calls whose arguments are invented or ungrounded.
 *
 * Free by default: schema checks (unknown tool, missing required, wrong type, enum) and a
 * grounding heuristic (does each argument value appear in what the agent had seen before the
 * call?). With an endpoint, each suspect argument also gets one typed yes/no question:
 * "Is this value stated in, or directly derivable from, the conversation so far?"
 */
import type { Endpoint } from "./endpoints";

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; items?: Schema; additionalProperties?: boolean };

export type Call = { index: number; name: string; args: Record<string, unknown>; context: string };

export type Finding = {
  call: number;
  tool: string;
  argument: string;
  value: string;
  kind: "unknown-tool" | "missing-required" | "wrong-type" | "not-in-enum" | "unexpected-argument" | "ungrounded" | "derived?" | "free text";
  severity: "error" | "warn" | "info";
  /** The typed judge's P(grounded), when an endpoint was given. */
  pGrounded?: number;
};

type Log = { tools: Record<string, Schema | null>; calls: Call[] };

const text = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : b && typeof b === "object" && "content" in b ? text(b.content) : "")).join("\n") : "";

/** OpenAI ({ messages, tools: [{ function: { name, parameters } }] }) or Anthropic ({ system, messages, tools: [{ name, input_schema }] }). */
export function parseLog(raw: unknown): Log {
  const log = raw as { system?: unknown; messages?: unknown[]; tools?: { name?: string; input_schema?: Schema; function?: { name: string; parameters?: Schema } }[] };
  const tools: Record<string, Schema | null> = {};

  for (const t of log.tools ?? []) {
    if (t.function) tools[t.function.name] = t.function.parameters ?? null;
    else if (t.name) tools[t.name] = t.input_schema ?? null;
  }

  const calls: Call[] = [];
  let context = text(log.system);

  for (const m of (log.messages ?? []) as { role: string; content?: unknown; tool_calls?: { function: { name: string; arguments: string } }[] }[]) {
    // OpenAI: assistant tool_calls with JSON-string arguments.
    for (const tc of m.tool_calls ?? []) {
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(tc.function.arguments || "{}");
      } catch {
        args = { _unparsed: tc.function.arguments };
      }

      calls.push({ index: calls.length, name: tc.function.name, args, context });
    }

    // Anthropic: tool_use blocks inside an assistant message's content.
    if (Array.isArray(m.content))
      for (const b of m.content as { type: string; name?: string; input?: Record<string, unknown> }[])
        if (b.type === "tool_use" && b.name) calls.push({ index: calls.length, name: b.name, args: b.input ?? {}, context });

    context += `\n${m.role}: ${text(m.content)}`;
  }

  return { tools, calls };
}

const typeOf = (v: unknown) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v);

const typeOk = (want: string | string[] | undefined, v: unknown) => {
  if (!want) return true;

  const got = typeOf(v);

  return [want].flat().some((w) => w === got || (w === "number" && got === "integer"));
};

/** Leaf values worth grounding: strings and numbers, with their dotted paths. */
function leaves(v: unknown, path: string, out: [string, string | number][] = []) {
  if (typeof v === "string" || typeof v === "number") out.push([path, v]);
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, path ? `${path}.${k}` : k, out);

  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-()+.,]/g, "");

/** Does the value appear in the context (loosely: case, spacing and punctuation ignored)? */
export function grounded(value: string | number, context: string) {
  const v = String(value).trim();

  if (!v) return true;

  const ctx = context.toLowerCase();

  if (ctx.includes(v.toLowerCase())) return true;

  const n = norm(v);

  return n.length >= 2 && norm(context).includes(n);
}

/** Values a model may fairly compute rather than copy: dates, times, small counts. */
const derivable = (v: string | number) => typeof v === "number" ? Math.abs(v) <= 12 : /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$|^\d{1,2}:\d{2}$/.test(v);

export function check(log: Log): Finding[] {
  const findings: Finding[] = [];

  for (const call of log.calls) {
    const known = Object.hasOwn(log.tools, call.name);
    const schema = known ? log.tools[call.name] : null;
    const add = (f: Omit<Finding, "call" | "tool">) => findings.push({ call: call.index, tool: call.name, ...f });

    if (!known && Object.keys(log.tools).length) add({ argument: "", value: "", kind: "unknown-tool", severity: "error" });

    if (schema) {
      for (const r of schema.required ?? []) if (!(r in call.args)) add({ argument: r, value: "", kind: "missing-required", severity: "error" });

      for (const [k, v] of Object.entries(call.args)) {
        const s = schema.properties?.[k];

        if (!s) {
          if (schema.additionalProperties === false) add({ argument: k, value: JSON.stringify(v), kind: "unexpected-argument", severity: "error" });
          continue;
        }
        if (!typeOk(s.type, v)) add({ argument: k, value: JSON.stringify(v), kind: "wrong-type", severity: "error" });
        if (s.enum && !s.enum.includes(v)) add({ argument: k, value: JSON.stringify(v), kind: "not-in-enum", severity: "error" });
      }
    }

    // An argument that already failed a schema check needs no second finding.
    const failed = new Set(findings.filter((f) => f.call === call.index && f.severity === "error").map((f) => f.argument));

    for (const [path, v] of leaves(call.args, "")) {
      const enumValue = schema?.properties?.[path]?.enum?.includes(v);

      if (enumValue || failed.has(path) || grounded(v, call.context)) continue;

      const value = String(v);

      if (derivable(v)) add({ argument: path, value, kind: "derived?", severity: "info" });
      // Prose the agent wrote (a message body, a summary) isn't a fact to copy; the judge can still check it.
      else if (typeof v === "string" && v.split(/\s+/).filter((w) => /[a-z]{2}/i.test(w)).length >= 4) add({ argument: path, value, kind: "free text", severity: "info" });
      else add({ argument: path, value, kind: "ungrounded", severity: "warn" });
    }
  }

  return findings;
}

/** Asks the endpoint one yes/no question per suspect argument; P(grounded) lands on the finding. */
export async function judge(log: Log, findings: Finding[], ep: Endpoint) {
  for (const f of findings) {
    if (f.kind !== "ungrounded" && f.kind !== "derived?" && f.kind !== "free text") continue;

    const call = log.calls[f.call]!;
    const r = await ep.ask({
      state: { Conversation: call.context.slice(-4000), Tool: f.tool, Argument: f.argument, Value: f.value },
      questions: {
        grounded: {
          type: "noul",
          instructions: "Is the value for this argument stated in, or directly derivable from, the conversation so far? Values the agent made up count as no.",
        },
      },
    });

    f.pGrounded = Number(r.answers.grounded?.value);

    if (Number.isFinite(f.pGrounded)) f.severity = f.pGrounded < 0.5 ? "warn" : "info";
  }

  return findings;
}
