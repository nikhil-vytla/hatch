import { describe, expect, test } from "bun:test";
import { point, sampleStroke, marks } from "./engine";
import { lexicalRank, requestFor } from "./model";
import { initialSession, reduce, type Session, type Token } from "./session";
const draw = (s: Session) => { const p = sampleStroke().points; s = reduce(s, { type: "begin", point: p[0] }); for (const value of p.slice(1)) s = reduce(s, { type: "move", point: value }); return reduce(s, { type: "end" }); };
const start = (s: Session, id = 1) => { const token = { id, epoch: s.epoch, revision: s.revision + 1 }; return { token, state: reduce(s, { type: "request", token, source: "jev", request: requestFor("golden pollen cloud") }) }; };
const resolve = (s: Session, token: Token) => reduce(s, { type: "resolve", token, ranking: lexicalRank("golden pollen cloud"), response: { mocked: true } });

describe("drawing and async judgment lifecycle", () => {
  test("drawing never blocks on a request; judgment queues until active stroke ends", () => {
    let { state: s, token } = start(initialSession());
    s = reduce(s, { type: "begin", point: point(5, 10) });
    s = reduce(s, { type: "move", point: point(50, 20) });
    expect(s.active?.points.length).toBe(2);
    s = resolve(s, token);
    expect(s.brushId).toBe("indigo-loom"); expect(s.active?.recipeId).toBe("indigo-loom"); expect(s.queued?.id).toBe("pollen-cloud");
    expect(s.receipts[0].events.at(-1)?.status).toBe("queued");
    s = reduce(s, { type: "end" });
    expect(s.brushId).toBe("pollen-cloud"); expect(s.strokes[0].recipeId).toBe("indigo-loom"); expect(s.receipts[0].events.map(e => e.status)).toEqual(["requested", "queued", "applied"]);
  });
  test("editing, hand selection, rewind, clear, cancel and restore invalidate late judgments", () => {
    const base = reduce(draw(initialSession()), { type: "save", name: "Checkpoint" });
    const actions = [{ type: "edit" }, { type: "select", id: "fern-script" }, { type: "rewind", cursor: 0 }, { type: "clear" }, { type: "cancel" }, { type: "restore", id: 1 }] as const;
    for (const action of actions) {
      const { state, token } = start(base); const changed = reduce(state, action), ended = resolve(changed, token);
      expect(ended.brushId).toBe(changed.brushId); expect(ended.cursor).toBe(changed.cursor); expect(ended.receipts[0].events.at(-1)?.status).toBe("discarded");
      expect(ended.receipts[0].response).toEqual({ mocked: true });
    }
  });
  test("a newer request supersedes the old one and failure preserves drawing", () => {
    const first = start(draw(initialSession()), 1), second = start(first.state, 2);
    let s = resolve(second.state, first.token); expect(s.request?.id).toBe(2); expect(s.brushId).toBe("indigo-loom");
    s = reduce(s, { type: "fail", token: second.token, error: "Unavailable" });
    expect(s.request).toBeNull(); expect(s.cursor).toBe(1); expect(s.receipts[1].events.at(-1)?.status).toBe("failed"); expect(s.brushId).toBe("indigo-loom");
  });
  test("queued judgment can be invalidated before lifting without changing active ink", () => {
    const a = start(initialSession()); let s = reduce(a.state, { type: "begin", point: point(10, 10) });
    s = resolve(s, a.token); s = reduce(s, { type: "edit" }); s = reduce(s, { type: "end" });
    expect(s.brushId).toBe("indigo-loom"); expect(s.receipts[0].events.at(-1)?.status).toBe("discarded");
  });
  test("manual selection after a model decision has honest origin", () => {
    const a = start(initialSession()); let s = resolve(a.state, a.token); expect(s.brushReceiptId).toBe(a.token.id);
    s = reduce(s, { type: "select", id: s.brushId }); expect(s.brushReceiptId).toBeUndefined();
  });
});
describe("immutable stroke checkpoints", () => {
  test("undo/redo replay exact marks; drawing on an old checkpoint preserves the future", () => {
    let s = draw(draw(initialSession())); const original = structuredClone(s.strokes), paths = marks(original[1]);
    s = reduce(s, { type: "rewind", cursor: 1 }); expect(s.strokes).toEqual(original);
    s = reduce(s, { type: "rewind", cursor: 2 }); expect(marks(s.strokes[1])).toEqual(paths);
    s = reduce(s, { type: "rewind", cursor: 1 }); s = reduce(s, { type: "select", id: "rose-kite" }); s = draw(s);
    expect(s.variants).toHaveLength(1); expect(s.variants[0].strokes).toEqual(original); expect(s.variants[0].cursor).toBe(2);
    expect(s.strokes[1].recipeId).toBe("rose-kite");
  });
  test("restoring preserves the abandoned branch and stable sample seeds", () => {
    let s = reduce(draw(initialSession()), { type: "save", name: "First" }); const original = structuredClone(s.strokes);
    s = draw(reduce(s, { type: "select", id: "coastal-wind" }));
    s = reduce(s, { type: "restore", id: 1 });
    expect(s.strokes).toEqual(original); expect(s.variants[1].cursor).toBe(2); expect(s.brushId).toBe("indigo-loom");
    expect(marks(s.strokes[0])).toEqual(marks(original[0]));
    const firstContinuation = draw(s).strokes[1];
    const restoredAgain = reduce(draw(s), { type: "restore", id: 1 });
    expect(draw(restoredAgain).strokes[1]).toEqual(firstContinuation);
  });
  test("pure transitions do not mutate saved stroke objects or receipts", () => {
    const a = start(draw(initialSession())); const snapshot = JSON.stringify(a.state); resolve(a.state, a.token);
    expect(JSON.stringify(a.state)).toBe(snapshot);
    expect(() => resolve(a.state, { id: 99, epoch: 99, revision: 99 })).not.toThrow();
  });
});


describe("cross-review regressions", () => {
  test("rewind during an active second stroke preserves both the active and finished stroke", () => {
    let s = draw(initialSession());
    s = reduce(s, { type: "begin", point: point(70, 90) });
    s = reduce(s, { type: "move", point: point(120, 150) });
    const before = structuredClone(s);
    s = reduce(s, { type: "rewind", cursor: 0 });
    expect(s.cursor).toBe(1); expect(s.strokes).toEqual(before.strokes); expect(s.active).toEqual(before.active);
    expect(s.epoch).toBe(before.epoch); expect(s.revision).toBe(before.revision);
    s = reduce(s, { type: "end" }); expect(s.cursor).toBe(2);
  });
  test("restoring recorded and live variants preserves the receipt that selected their brush", () => {
    for (const source of ["recorded", "jev"] as const) {
      let s = initialSession(); const token = { id: 1, epoch: s.epoch, revision: s.revision + 1 };
      s = reduce(s, { type: "request", token, source, request: requestFor("golden pollen cloud") });
      s = resolve(s, token); s = draw(s); s = reduce(s, { type: "save", name: source });
      expect(s.variants[0].brushReceiptId).toBe(1);
      s = reduce(s, { type: "select", id: "fern-script" }); expect(s.brushReceiptId).toBeUndefined();
      s = reduce(s, { type: "restore", id: 1 });
      expect(s.brushReceiptId).toBe(1); expect(s.brushId).toBe("pollen-cloud");
      expect(s.receipts.find(r => r.token.id === s.brushReceiptId)?.source).toBe(source);
    }
  });
});
