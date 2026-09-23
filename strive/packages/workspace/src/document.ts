// The desktop workspace: columns of panels, as data. People rearrange it by
// dragging; the agent proposes edits to it. Both are the same ID-addressed
// ops, so an edit still applies after the layout has changed around it.

import { LIMITS, type Op, type Workspace } from "./schema";

export const DEFAULT_WORKSPACE: Workspace = {
  version: 1,
  columns: [
    { id: "main", grow: 2, panels: ["transcript"] },
    { id: "side", grow: 1, panels: ["approvals", "spend", "checkpoints", "activity"] },
  ],
  panels: [
    { id: "transcript", kind: "transcript" },
    { id: "approvals", kind: "approvals" },
    { id: "spend", kind: "spend" },
    { id: "checkpoints", kind: "checkpoints" },
    { id: "activity", kind: "activity" },
  ],
};

export type Applied = { ok: true; workspace: Workspace } | { ok: false; error: string };

const fail = (error: string): Applied => ({ ok: false, error });

function insert(list: string[], id: string, before?: string): string[] {
  const at = before === undefined ? -1 : list.indexOf(before);

  return at === -1 ? [...list, id] : [...list.slice(0, at), id, ...list.slice(at)];
}

/** Applies one op, or says why it can't. The workspace given is not changed. */
export function applyOp(w: Workspace, op: Op): Applied {
  switch (op.op) {
    case "move": {
      if (!w.panels.some((p) => p.id === op.panel)) return fail(`no panel ${op.panel}`);

      if (!w.columns.some((c) => c.id === op.column)) return fail(`no column ${op.column}`);

      const columns = w.columns.map((c) => {
        const rest = c.panels.filter((p) => p !== op.panel);

        return c.id === op.column ? { ...c, panels: insert(rest, op.panel, op.before) } : { ...c, panels: rest };
      });

      return { ok: true, workspace: { ...w, columns } };
    }

    case "add": {
      if (w.panels.some((p) => p.id === op.panel.id)) return fail(`a panel ${op.panel.id} already exists`);

      if (!w.columns.some((c) => c.id === op.column)) return fail(`no column ${op.column}`);

      if (w.panels.length >= LIMITS.panels) return fail(`a workspace holds at most ${LIMITS.panels} panels`);

      const columns = w.columns.map((c) =>
        c.id === op.column ? { ...c, panels: insert(c.panels, op.panel.id, op.before) } : c,
      );

      return { ok: true, workspace: { ...w, columns, panels: [...w.panels, op.panel] } };
    }

    case "remove": {
      if (!w.panels.some((p) => p.id === op.panel)) return fail(`no panel ${op.panel}`);

      return {
        ok: true,
        workspace: {
          ...w,
          columns: w.columns.map((c) => ({ ...c, panels: c.panels.filter((p) => p !== op.panel) })),
          panels: w.panels.filter((p) => p.id !== op.panel),
        },
      };
    }

    case "resize": {
      if (!(op.grow > 0 && op.grow <= 10)) return fail("a column's share is between 0 and 10");

      if (!w.columns.some((c) => c.id === op.column)) return fail(`no column ${op.column}`);

      return {
        ok: true,
        workspace: { ...w, columns: w.columns.map((c) => (c.id === op.column ? { ...c, grow: op.grow } : c)) },
      };
    }

    default:
      return op satisfies never;
  }
}

/** Applies ops in order, all or nothing. */
export function applyOps(w: Workspace, ops: Op[]): Applied {
  let current = w;

  for (const [i, op] of ops.entries()) {
    const r = applyOp(current, op);

    if (!r.ok) return fail(`op ${i + 1}: ${r.error}`);
    current = r.workspace;
  }

  return { ok: true, workspace: current };
}
