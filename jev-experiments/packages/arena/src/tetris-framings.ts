/**
 * Ways to ask a typed-decision model where a Tetris piece should land.
 *
 * "landing-choice" hands over every reachable landing as JSON features in one
 * choice (the original recorded framing). The other two follow Laya's
 * playground: code does the counting and comparing, each distinct landing is
 * described in one plain sentence, and the model judges each sentence on its
 * own. Code then picks the best-judged landing.
 */
import { boardFeatures, type Landing } from "../../../live-worlds/tetris/engine";
import { optionCriteria, type Answer, type Contestant, type Question } from "./tetris";
import { DECISION_INSTRUCTIONS } from "../../../live-worlds/tetris/session";

export type FramingId = "landing-choice" | "spot-clean" | "spot-score";
export type Wire = { state: unknown; questions: Record<string, { type: "choice" | "noul" | "score"; instructions: string; criteria?: Record<string, string> | string[] }> };
export type WireAnswer = { value: string | number; probabilities?: Record<string, number> | null; confidence?: number | null };
export type Send = (body: Wire) => Promise<{ answers: Record<string, WireAnswer> }>;

const HOLES = ["no new holes", "one new hole", "two new holes", "three new holes", "many new holes"];
const LINES = ["", "one line", "two lines", "three lines", "four lines"];
const BUMPS = ["no bump", "a small bump", "a big bump", "a tall tower"];
const grade = (v: number, from: number, step: number) => Math.max(0, Math.min(3, Math.ceil((v - from) / step)));

/** Counting happens here; the model gets the conclusion in words (after Laya's survey()). */
export function describeLanding(before: ReturnType<typeof boardFeatures>, landing: Landing, cols = 10) {
  const f = landing.features;
  if (f.topOut) return "The piece does not fit and ends the game.";
  const holes = Math.max(0, f.holes - before.holes);
  const avg = before.aggregateHeight / cols;
  const bump = Math.max(grade(f.bumpiness - before.bumpiness, 0, 2), grade(f.height - avg, 3, 1));
  return `The piece leaves ${HOLES[Math.min(4, holes)]} under it and makes ${BUMPS[bump]} on top.` + (f.lines ? ` It completes ${LINES[f.lines]}.` : "");
}

/** Distinct sentences in left-to-right order, each with the landings it describes. */
const boardOf = (q: Question) => q.state.board.map((row) => [...row].map((c) => (c === "#" ? 1 : 0)));
export function spots(q: Question) {
  const before = boardFeatures(boardOf(q)), options = q.options;
  const left = (l: Landing) => Math.min(...l.id.split("-").map((c) => +c.split("_")[0]));
  const ordered = [...options].sort((a, b) => left(a) - left(b) || a.id.localeCompare(b.id));
  const groups = new Map<string, Landing[]>();
  for (const l of ordered) { const s = describeLanding(before, l); groups.set(s, [...(groups.get(s) ?? []), l]); }
  return [...groups.entries()].map(([sentence, landings], i) => ({ key: `spot_${String.fromCharCode(97 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`, sentence, landings }));
}

const SCORE_LEVELS = [
  "Bad: the piece buries empty cells or builds a tall tower.",
  "Poor: no new holes, but the top gets clearly rougher.",
  "Fine: no new holes and only a small bump.",
  "Great: it completes a line, or keeps the top flat with no new holes.",
];

export type Built = { body: Wire; read(answers: Record<string, WireAnswer>): { choice: string; probabilities: Record<string, number>; judged: Record<string, number> } };

export function buildRequest(framing: FramingId, q: Question): Built {
  if (framing === "landing-choice") {
    const body: Wire = { state: q.state, questions: { decision: { type: "choice", instructions: DECISION_INSTRUCTIONS.landing, criteria: optionCriteria(q.options) } } };
    return { body, read: (a) => ({ choice: String(a.decision.value), probabilities: a.decision.probabilities ?? { [String(a.decision.value)]: 1 }, judged: {} }) };
  }
  const groups = spots(q);
  const state = { task: "A Tetris piece is about to land. Each spot below is one place it could come to rest, described after code worked out the result.", piece: q.state.active.type, spots: Object.fromEntries(groups.map((g) => [g.key, g.sentence])) };
  const questions: Wire["questions"] = Object.fromEntries(groups.map((g) => [g.key, framing === "spot-clean"
    ? { type: "noul" as const, instructions: `After the piece lands at ${g.key}, the stack stays clean: flat, with no new holes and no tall tower.` }
    : { type: "score" as const, instructions: `How good is landing the piece at ${g.key} for the stack?`, criteria: SCORE_LEVELS }]));
  return {
    body: { state, questions },
    read(answers) {
      // Code compares: the best-judged sentence wins; ties keep the leftmost, as in Laya.
      const judged = Object.fromEntries(groups.map((g) => {
        const a = answers[g.key];
        return [g.key, framing === "spot-clean" ? Number(a.value) : Number(a.value) / (SCORE_LEVELS.length - 1)];
      }));
      let best = groups[0];
      for (const g of groups) if (judged[g.key] > judged[best.key]) best = g;
      const total = Object.values(judged).reduce((s, v) => s + v, 0) || 1;
      // Spread each sentence's judgement over the landings it describes, for display.
      const probabilities = Object.fromEntries(groups.flatMap((g) => g.landings.map((l) => [l.id, judged[g.key] / total / g.landings.length])));
      return { choice: best.landings[0].id, probabilities, judged };
    },
  };
}

export const FRAMING_NAMES: Record<FramingId, string> = {
  "landing-choice": "Pick one landing (features as JSON)",
  "spot-clean": "Judge each spot: clean or not",
  "spot-score": "Rate each spot 0–3",
};

/** A live contestant that asks with one framing. `record` receives every exchange. */
export type Exchange = { framing: FramingId; pieceId: number; board: string[]; body: Wire; response?: unknown; error?: string; attempts?: { status: unknown; retryAfterMs?: number }[]; ms: number };
export function framedJev(framing: FramingId, send: Send, record?: (exchange: Exchange) => void): Contestant {
  return {
    id: `jev-${framing}`, name: `Jev · ${FRAMING_NAMES[framing]}`, source: "live",
    ask(q): Promise<Answer> {
      const built = buildRequest(framing, q), started = performance.now();
      return send(built.body).then((response) => {
        const ms = performance.now() - started, out = built.read(response.answers);
        record?.({ framing, pieceId: q.pieceId, board: q.state.board, body: built.body, response, ms });
        return { choice: out.choice, probabilities: out.probabilities, confidence: null, latencyMs: ms };
      }, (error) => {
        const ms = performance.now() - started;
        record?.({ framing, pieceId: q.pieceId, board: q.state.board, body: built.body, error: String(error?.message ?? error), attempts: (error?.attempts ?? []).map((a: any) => ({ status: a.status, retryAfterMs: a.retryAfterMs })), ms });
        return { error: String(error?.message ?? error), latencyMs: ms };
      });
    },
  };
}

/**
 * Replays recorded exchanges for one framing. An answer applies wherever the
 * same piece meets the same stack, so a turn-based recording also plays in
 * real time, landing after its recorded latency.
 */
export function recordedFraming(exchanges: Exchange[], framing: FramingId): Contestant {
  const mine = exchanges.filter((x) => x.framing === framing);
  const find = (q: Question) => mine.find((x) => x.pieceId === q.pieceId && JSON.stringify(x.board) === JSON.stringify(q.state.board));
  return {
    id: `jev-${framing}-recorded`, name: `Jev · ${FRAMING_NAMES[framing]}`, source: "recorded",
    ask(q) {
      const x = find(q);
      if (!x) return { missing: "No recorded answer for this exact stack and piece" };
      const at = q.sentAt + (x.ms ?? 0);
      if (x.error || !x.response) return { receiveAt: at, answer: { error: x.error ?? "Recorded failure", latencyMs: x.ms } };
      const out = buildRequest(framing, q).read((x.response as any).answers);
      return { receiveAt: at, answer: { choice: out.choice, probabilities: out.probabilities, confidence: null, latencyMs: x.ms } };
    },
  };
}
