// A workspace is its base plus the edits made to it, folded in order. Any
// edit can be reverted on its own, even after later ones: the workspace is
// folded again without it, and ops that no longer apply are skipped (and
// reported). The agent's edits arrive as proposals, which change nothing
// until a person accepts them.
import { applyOp } from "./document";
import type { Edit, History, Op, Workspace } from "./schema";

export type Author = Edit["author"];

export type Folded = {
  workspace: Workspace;
  /** Ops that no longer applied, with why. */
  skipped: { edit: number; error: string }[];
};

export const history = (base: Workspace): History => ({ base, edits: [], nextId: 1 });

/** The workspace the history describes. */
export function fold(h: History): Folded {
  let workspace = h.base;
  const skipped: Folded["skipped"] = [];

  for (const edit of h.edits) {
    if (edit.reverted) continue;

    for (const op of edit.ops) {
      const r = applyOp(workspace, op);

      if (r.ok) workspace = r.workspace;
      else skipped.push({ edit: edit.id, error: r.error });
    }
  }

  return { workspace, skipped };
}

export type Recorded = { ok: true; history: History; edit: number } | { ok: false; error: string };

/**
 * Records an edit if every op applies to the current workspace, so a
 * proposal is judged against what the person sees now.
 */
export function record(h: History, author: Author, label: string, ops: Op[]): Recorded {
  let workspace = fold(h).workspace;

  for (const [i, op] of ops.entries()) {
    const r = applyOp(workspace, op);

    if (!r.ok) return { ok: false, error: `op ${i + 1}: ${r.error}` };
    workspace = r.workspace;
  }

  const edit: Edit = { id: h.nextId, author, label, ops, reverted: false };

  return { ok: true, history: { ...h, edits: [...h.edits, edit], nextId: h.nextId + 1 }, edit: edit.id };
}

/** Reverts one edit (or puts it back), leaving the others. */
export function setReverted(h: History, edit: number, reverted: boolean): History {
  return { ...h, edits: h.edits.map((e) => (e.id === edit ? { ...e, reverted } : e)) };
}

/** The last edit still in effect, for undo. */
export const lastActive = (h: History): Edit | undefined => h.edits.findLast((e) => !e.reverted);
