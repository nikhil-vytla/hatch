import { expect, test } from "bun:test";
import * as v from "valibot";
import { applyOps, DEFAULT_WORKSPACE, showPanel } from "./document";
import { fold, history, lastActive, record, setReverted } from "./history";
import { HistorySchema, type Op, ProposalSchema, parseJson, type Workspace, WorkspaceSchema } from "./schema";

const column = (w: Workspace, id: string) => w.columns.find((c) => c.id === id)?.panels;

/** A workspace with the side column full, as a person might have arranged it. */
const SIDE: Workspace = {
  ...DEFAULT_WORKSPACE,
  columns: [
    { id: "main", grow: 2, panels: ["transcript"] },
    { id: "side", grow: 1, panels: ["approvals", "spend", "checkpoints", "activity"] },
  ],
};

function applied(w: Workspace, ops: Op[]): Workspace {
  const r = applyOps(w, ops);

  if (!r.ok) throw new Error(r.error);

  return r.workspace;
}

test("an agent's move still lands where it meant after the person rearranged things", () => {
  // The person has put checkpoints first; the agent, not knowing, asks for spend before checkpoints.
  const rearranged = applied(SIDE, [{ op: "move", panel: "checkpoints", column: "side", before: "approvals" }]);

  const w = applied(rearranged, [{ op: "move", panel: "spend", column: "side", before: "checkpoints" }]);
  expect(column(w, "side")).toEqual(["spend", "checkpoints", "approvals", "activity"]);
});

test("a move across columns leaves the panel in exactly one place", () => {
  const w = applied(SIDE, [{ op: "move", panel: "spend", column: "main" }]);
  expect(column(w, "main")).toEqual(["transcript", "spend"]);
  expect(column(w, "side")).not.toContain("spend");
});

test("ops apply all or nothing, and the error names the op that failed", () => {
  const r = applyOps(SIDE, [
    { op: "move", panel: "spend", column: "main" },
    { op: "add", panel: { id: "transcript", kind: "transcript" }, column: "main" },
  ]);

  expect(r).toEqual({ ok: false, error: "op 2: a panel transcript already exists" });
  expect(column(SIDE, "main")).toEqual(["transcript"]);
});

test("an agent widget's HTML is capped", () => {
  const panel = { id: "w", kind: "html", title: "W", html: "x".repeat(64 * 1024 + 1) };
  const proposal = JSON.stringify({ label: "big", ops: [{ op: "add", panel, column: "side" }] });
  expect(parseJson(ProposalSchema, proposal)).toEqual({
    ok: false,
    error: "ops.0.panel.html: a widget's HTML is at most 64 KiB",
  });
});

test("reverting an agent's edit keeps the person's later edits", () => {
  const agent = record(history(SIDE), "agent", "show a notes widget", [
    { op: "add", panel: { id: "notes", kind: "html", title: "Notes", html: "<p>hi</p>" }, column: "side" },
  ]);

  if (!agent.ok) throw new Error(agent.error);

  const person = record(agent.history, "person", "drag", [{ op: "move", panel: "spend", column: "main" }]);

  if (!person.ok) throw new Error(person.error);

  const h = setReverted(person.history, agent.edit, true);
  const { workspace, skipped } = fold(h);
  expect(workspace.panels.some((p) => p.id === "notes")).toBe(false);
  expect(column(workspace, "main")).toEqual(["transcript", "spend"]);
  expect(skipped).toEqual([]);
  expect(lastActive(h)?.author).toBe("person");
});

test("a later edit that needed a reverted one is skipped, and says why", () => {
  const added = record(history(SIDE), "agent", "add", [
    { op: "add", panel: { id: "notes", kind: "html", title: "Notes", html: "" }, column: "side" },
  ]);

  if (!added.ok) throw new Error(added.error);

  const moved = record(added.history, "person", "drag", [{ op: "move", panel: "notes", column: "main" }]);

  if (!moved.ok) throw new Error(moved.error);

  const { workspace, skipped } = fold(setReverted(moved.history, added.edit, true));
  expect(column(workspace, "main")).toEqual(["transcript"]);
  expect(skipped).toEqual([{ edit: moved.edit, error: "no panel notes" }]);
});

test("an edit that doesn't apply to the workspace as it is now isn't recorded", () => {
  const r = record(history(SIDE), "agent", "move", [{ op: "move", panel: "ghost", column: "side" }]);
  expect(r).toEqual({ ok: false, error: "op 1: no panel ghost" });
});

test("a history survives JSON, and bad JSON is refused with a reason", () => {
  const r = record(history(SIDE), "person", "drag", [{ op: "resize", column: "side", grow: 1.5 }]);

  if (!r.ok) throw new Error(r.error);

  expect(parseJson(HistorySchema, JSON.stringify(r.history))).toEqual({ ok: true, value: r.history });

  const proposal = (ops: object[]) => parseJson(ProposalSchema, JSON.stringify({ label: "x", ops }));
  expect(proposal([{ op: "explode" }]).ok).toBe(false);
  expect(proposal([{ op: "move", panel: "../etc", column: "side" }])).toEqual({
    ok: false,
    error: "ops.0.panel: use 1 to 40 letters, digits, - and _",
  });

  const dangling = { version: 1, columns: [{ id: "c", grow: 1, panels: ["nope"] }], panels: [] };
  expect(parseJson(WorkspaceSchema, JSON.stringify(dangling))).toEqual({
    ok: false,
    error: "a column places a panel that doesn't exist",
  });

  expect(parseJson(WorkspaceSchema, "{")).toEqual({ ok: false, error: "not JSON" });
  expect(v.is(WorkspaceSchema, DEFAULT_WORKSPACE)).toBe(true);
  expect(v.is(WorkspaceSchema, SIDE)).toBe(true);
});

test("showing a panel moves one that isn't placed, adds back one that was removed, and leaves one on screen", () => {
  expect(showPanel(DEFAULT_WORKSPACE, "spend")).toEqual([{ op: "move", panel: "spend", column: "side" }]);
  const removed = applied(DEFAULT_WORKSPACE, [{ op: "remove", panel: "spend" }]);
  const added = showPanel(removed, "spend");
  expect(added).toEqual([{ op: "add", panel: { id: "spend", kind: "spend" }, column: "side" }]);
  expect(column(applied(removed, added), "side")).toEqual(["spend"]);
  expect(showPanel(SIDE, "spend")).toEqual([]);
  const noSide: Workspace = { ...DEFAULT_WORKSPACE, columns: [{ id: "only", grow: 1, panels: ["transcript"] }] };
  expect(showPanel(noSide, "checkpoints")).toEqual([{ op: "move", panel: "checkpoints", column: "only" }]);
});
