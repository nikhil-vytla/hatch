import { point, recipe, type Point, type Stroke } from "./engine";
import { validateRanking, type Ranking, type requestFor } from "./model";
export type Token = { id: number; epoch: number; revision: number };
export type Receipt = { token: Token; source: "lexical" | "jev" | "recorded"; request: ReturnType<typeof requestFor>; ranking?: Ranking; response?: unknown; events: { status: "requested" | "loaded" | "queued" | "applied" | "discarded" | "failed"; detail: string }[] };
export type Variant = { id: number; name: string; strokes: Stroke[]; brushId: string; brushReceiptId?: number; cursor: number; epoch: number; nextStroke: number };
type Selection = { id: string; receiptId?: number };
export type Session = { brushId: string; brushReceiptId?: number; strokes: Stroke[]; cursor: number; active: Stroke | null; nextStroke: number; epoch: number; revision: number; queued: Selection | null; request: Token | null; receipts: Receipt[]; variants: Variant[]; notice: string };
export const initialSession = (): Session => ({ brushId: "indigo-loom", strokes: [], cursor: 0, active: null, nextStroke: 1, epoch: 1, revision: 0, queued: null, request: null, receipts: [], variants: [], notice: "Draw a curve. Every mark is made here in code." });
export type Action =
  | { type: "begin"; point: Point }
  | { type: "move"; point: Point }
  | { type: "end" }
  | { type: "select"; id: string }
  | { type: "edit" }
  | { type: "rewind"; cursor: number }
  | { type: "save"; name?: string }
  | { type: "restore"; id: number }
  | { type: "clear" }
  | { type: "request"; token: Token; source: Receipt["source"]; request: Receipt["request"] }
  | { type: "resolve"; token: Token; ranking: Ranking; response: unknown }
  | { type: "fail"; token: Token; error: string }
  | { type: "cancel" };
const same = (a: Token | null, b: Token) => a?.id === b.id && a.epoch === b.epoch && a.revision === b.revision;
function event(s: Session, id: number | undefined, status: Receipt["events"][number]["status"], detail: string): Session {
  return id === undefined ? s : { ...s, receipts: s.receipts.map(r => r.token.id === id ? { ...r, events: [...r.events, { status, detail }] } : r) };
}
function invalidate(s: Session, detail: string): Session {
  let next = event(s, s.request?.id, "discarded", detail);
  if (s.queued?.receiptId !== s.request?.id) next = event(next, s.queued?.receiptId, "discarded", detail);
  return { ...next, request: null, queued: null, revision: s.revision + 1 };
}
function preserve(s: Session, name: string, full = false): Session {
  if (!s.strokes.length) return s;
  const variant: Variant = { id: s.variants.length + 1, name, strokes: [...s.strokes], cursor: full ? s.strokes.length : s.cursor, brushId: s.brushId, brushReceiptId: s.brushReceiptId, epoch: s.epoch, nextStroke: s.nextStroke };
  return { ...s, variants: [...s.variants, variant] };
}
function select(s: Session, selection: Selection): Session {
  recipe(selection.id);
  if (s.active) return { ...event(s, selection.receiptId, "queued", "Waiting for this stroke to end."), queued: selection, notice: `${recipe(selection.id).name} is ready for the next stroke.` };
  return { ...event(s, selection.receiptId, "applied", "Applied between strokes."), brushId: selection.id, brushReceiptId: selection.receiptId, queued: null, notice: `${recipe(selection.id).name} is on the brush.` };
}
export function reduce(s: Session, a: Action): Session {
  switch (a.type) {
    case "begin": {
      if (s.active) return s;
      if (s.cursor >= 80) return { ...s, notice: "This sheet has 80 strokes. Export or preserve it, then start a fresh sheet." };
      let next = s;
      if (s.cursor < s.strokes.length) next = preserve(s, `Before fork · ${s.strokes.length} strokes`, true);
      return { ...next, strokes: s.strokes.slice(0, s.cursor), active: { id: s.nextStroke, seed: (1943 + Math.imul(s.nextStroke, 73856093)) >>> 0, recipeId: s.brushId, points: [point(a.point.x, a.point.y, a.point.pressure)] }, nextStroke: s.nextStroke + 1 };
    }
    case "move": {
      if (!s.active) return s;
      const p = point(a.point.x, a.point.y, a.point.pressure), last = s.active.points.at(-1)!;
      if (Math.hypot(p.x - last.x, p.y - last.y) < 3) return s;
      if (s.active.points.length >= 1200) return { ...s, notice: "This stroke has 1,200 samples. Lift and continue with another stroke." };
      return { ...s, active: { ...s.active, points: [...s.active.points, p] } };
    }
    case "end": {
      if (!s.active) return s;
      let next = { ...s, strokes: [...s.strokes.slice(0, s.cursor), s.active], cursor: s.cursor + 1, active: null } as Session;
      if (s.queued) next = select(next, s.queued);
      return next;
    }
    case "select": return select(invalidate(s, "A recipe was chosen directly."), { id: a.id });
    case "edit": return { ...invalidate(s, "The style phrase changed."), notice: "Phrase updated. Preview locally or ask Jev when ready." };
    case "cancel": return { ...invalidate(s, "Cancelled by the artist."), notice: "Request cancelled. Keep drawing with the current recipe." };
    case "rewind": {
      if (s.active) return { ...s, notice: "Lift the pen before rewinding finished strokes." };
      const next = invalidate(s, "The stroke checkpoint changed.");
      return { ...next, cursor: Math.max(0, Math.min(s.strokes.length, Math.floor(a.cursor))), active: null, epoch: s.epoch + 1, notice: "History moved. Drawing here preserves the old future as a variant." };
    }
    case "save": return { ...preserve(s, a.name?.trim() || `Variant ${s.variants.length + 1}`), notice: "Variant preserved with its stroke samples and recipes." };
    case "restore": {
      const v = s.variants.find(v => v.id === a.id); if (!v) return s;
      const next = preserve(invalidate(s, "A preserved variant was restored."), `Before restore · ${s.cursor} strokes`);
      return { ...next, strokes: [...v.strokes], cursor: v.cursor, brushId: v.brushId, brushReceiptId: v.brushReceiptId, nextStroke: v.nextStroke, active: null, epoch: s.epoch + 1, notice: `${v.name} restored. Previous work is preserved.` };
    }
    case "clear": {
      const next = preserve(invalidate(s, "A fresh sheet was started."), `Previous sheet · ${s.cursor} strokes`);
      return { ...next, strokes: [], cursor: 0, active: null, epoch: s.epoch + 1, notice: "Fresh sheet. The previous sheet is in preserved variants." };
    }
    case "request": {
      const next = invalidate(s, "A newer style request replaced this one.");
      // The caller captures the revision after this one-step invalidation.
      if (a.token.epoch !== s.epoch || a.token.revision !== s.revision + 1) return s;
      return { ...next, request: a.token, receipts: [...next.receipts, { token: a.token, source: a.source, request: a.request, events: [{ status: a.source === "recorded" ? "loaded" : "requested", detail: a.source === "jev" ? "Requested 10 description fit judgments." : a.source === "recorded" ? "Loaded 10 genuine judgments from an authored recorded example. No model request was made." : "Ran declared tag matching locally." }] }], notice: a.source === "jev" ? "Jev is reading the recipe descriptions. Keep drawing." : a.source === "recorded" ? "Loaded a recorded Jev example." : "Matching words against recipe tags." };
    }
    case "resolve": {
      validateRanking(a.ranking);
      const next = { ...s, receipts: s.receipts.map(r => r.token.id === a.token.id ? { ...r, ranking: a.ranking, response: a.response } : r) };
      if (!same(s.request, a.token) || s.revision !== a.token.revision || s.epoch !== a.token.epoch) return next;
      return select({ ...next, request: null }, { id: a.ranking[0].id, receiptId: a.token.id });
    }
    case "fail": {
      if (!same(s.request, a.token)) return s;
      return { ...event(s, a.token.id, "failed", a.error), request: null, notice: a.error };
    }
  }
}
