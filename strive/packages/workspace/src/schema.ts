// The workspace's shapes, as schemas: the types the code uses are derived
// from them, and JSON from disk or from the agent is parsed with them.
import * as v from "valibot";

export const LIMITS = { panels: 32, htmlBytes: 64 * 1024 } as const;

const Id = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,40}$/, "use 1 to 40 letters, digits, - and _"));

const Html = v.pipe(
  v.string(),
  v.check(
    (html) => new TextEncoder().encode(html).length <= LIMITS.htmlBytes,
    `a widget's HTML is at most ${LIMITS.htmlBytes / 1024} KiB`,
  ),
);

export const PanelSchema = v.variant("kind", [
  v.object({ id: Id, kind: v.picklist(["transcript", "spend", "approvals", "checkpoints", "activity"]) }),
  v.object({ id: Id, kind: v.literal("html"), title: v.string(), html: Html }),
]);

export const ColumnSchema = v.object({
  id: Id,
  grow: v.pipe(v.number(), v.gtValue(0), v.maxValue(10)),
  panels: v.array(Id),
});

export const WorkspaceSchema = v.pipe(
  v.object({ version: v.literal(1), columns: v.array(ColumnSchema), panels: v.array(PanelSchema) }),
  v.check((w) => new Set(w.panels.map((p) => p.id)).size === w.panels.length, "two panels share an id"),
  v.check((w) => {
    const placed = w.columns.flatMap((c) => c.panels);

    return new Set(placed).size === placed.length;
  }, "a panel is placed twice"),
  v.check((w) => {
    const known = new Set(w.panels.map((p) => p.id));

    return w.columns.every((c) => c.panels.every((id) => known.has(id)));
  }, "a column places a panel that doesn't exist"),
);

export const OpSchema = v.variant("op", [
  v.object({ op: v.literal("move"), panel: Id, column: Id, before: v.optional(Id) }),
  v.object({ op: v.literal("add"), panel: PanelSchema, column: Id, before: v.optional(Id) }),
  v.object({ op: v.literal("remove"), panel: Id }),
  v.object({ op: v.literal("resize"), column: Id, grow: v.number() }),
]);

export const EditSchema = v.object({
  id: v.number(),
  author: v.picklist(["person", "agent"]),
  /** What the edit is for, in the author's words. */
  label: v.string(),
  ops: v.array(OpSchema),
  reverted: v.boolean(),
});

export const HistorySchema = v.object({
  base: WorkspaceSchema,
  edits: v.array(EditSchema),
  nextId: v.number(),
  /** Agent proposals already accepted or rejected, by key, so they aren't offered again. */
  decided: v.optional(v.array(v.string()), []),
});

/** An agent's proposed change to the layout. */
export const ProposalSchema = v.object({ label: v.pipe(v.string(), v.nonEmpty()), ops: v.array(OpSchema) });

export type Panel = v.InferOutput<typeof PanelSchema>;

export type PanelKind = Panel["kind"];

export type Column = v.InferOutput<typeof ColumnSchema>;

export type Workspace = v.InferOutput<typeof WorkspaceSchema>;

export type Op = v.InferOutput<typeof OpSchema>;

export type Edit = v.InferOutput<typeof EditSchema>;

export type History = v.InferOutput<typeof HistorySchema>;

export type Proposal = v.InferOutput<typeof ProposalSchema>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parses JSON text with a schema; the error says where and what. */
export function parseJson<S extends v.GenericSchema>(schema: S, text: string): Parsed<v.InferOutput<S>> {
  let json: ReturnType<typeof JSON.parse>;

  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "not JSON" };
  }

  const r = v.safeParse(schema, json);

  if (r.success) return { ok: true, value: r.output };

  const issue = r.issues[0];
  const path = issue.path?.map((p) => String(p.key)).join(".");

  return { ok: false, error: path ? `${path}: ${issue.message}` : issue.message };
}
