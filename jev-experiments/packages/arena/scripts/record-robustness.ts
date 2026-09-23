/**
 * Robustness checks for the "judge each spot" Tetris design.
 *
 * Part A (position and batching), fixed before running: replay the recorded
 * turn-based spot-clean games on seeds 7/19/42 and take pieces 1, 5, 9, ...,
 * 37 (30 boards). Ask about each board four ways: original order, original
 * order again (run-to-run variation), reversed order with labels reassigned
 * (spot_a becomes the last sentence), and each sentence in its own request.
 *
 * Part B (more seeds): turn-based 40-piece games on seeds 3, 11, 23, 31 for
 * spot-clean and landing-choice, one lane per design in the same arena.
 *
 * One request at a time with patient retries (nothing here is timed). Weak
 * answers are never retried. Refuses to overwrite existing outputs.
 *
 *   bun jev-experiments/packages/arena/scripts/record-robustness.ts
 */
import "../../../experience-prototypes/scripts/credentials";
import { evaluate } from "../../../experience-prototypes/server/gateway";
import { TetrisArena, heuristic, type Contestant, type Question } from "../src/tetris";
import { framedJev, recordedFraming, spots, type Exchange, type Wire } from "../src/tetris-framings";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const key = process.env.AI_GATEWAY_API_KEY;
if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");
const dir = new URL("../recordings/", import.meta.url);
const out = { position: new URL("robustness-position.jsonl.gz", dir), positionSummary: new URL("robustness-position-summary.json", dir), seeds: new URL("turns-more-seeds.replay.jsonl", dir), seedsRaw: new URL("turns-more-seeds.jsonl.gz", dir), seedsSummary: new URL("turns-more-seeds-summary.json", dir) };
if (Object.values(out).some((u) => existsSync(u))) throw Error("Outputs already exist. Preserve them; do not overwrite recorded outcomes.");

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> { const next = chain.then(() => new Promise((r) => setTimeout(r, 300))).then(work); chain = next.catch(() => {}); return next; }
const send = (body: Wire) => serial(() => evaluate(body as any, { apiKey: key, maxAttempts: 6, deadlineMs: 180_000 }));
const recordedAt = new Date().toISOString();
const INSTRUCTION = (k: string) => `After the piece lands at ${k}, the stack stays clean: flat, with no new holes and no tall tower.`;
const TASK = "A Tetris piece is about to land. Each spot below is one place it could come to rest, described after code worked out the result.";

/** A batched body over sentences in the given order; keys follow that order. */
function body(piece: string, sentences: string[]): { wire: Wire; keyOf: Map<string, string> } {
  const keyOf = new Map(sentences.map((s, i) => [s, `spot_${String.fromCharCode(97 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`]));
  return { keyOf, wire: { state: { task: TASK, piece, spots: Object.fromEntries(sentences.map((s) => [keyOf.get(s)!, s])) }, questions: Object.fromEntries(sentences.map((s) => [keyOf.get(s)!, { type: "noul" as const, instructions: INSTRUCTION(keyOf.get(s)!) }])) } };
}
async function judge(piece: string, sentences: string[]) {
  const { wire, keyOf } = body(piece, sentences);
  try {
    const r: any = await send(wire);
    return { judged: Object.fromEntries(sentences.map((s) => [s, Number(r.answers[keyOf.get(s)!].value)])), wire, response: r };
  } catch (e: any) { return { error: String(e?.message ?? e), wire }; }
}

// ---------- Part A ----------
const turns = readFileSync(new URL("tetris-framings.replay.jsonl", dir), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const boards: { seed: number; q: Question }[] = [];
for (const seed of [7, 19, 42]) {
  const want = new Set(Array.from({ length: 10 }, (_, i) => 1 + i * 4));
  const inner = recordedFraming(turns.filter((x: any) => x.seed === seed), "spot-clean");
  const capture: Contestant = { ...inner, ask(q, mode, signal) { if (want.has(q.pieceId)) boards.push({ seed, q }); return inner.ask(q, mode, signal); } };
  const arena = new TetrisArena(seed, [capture], "turns", { pieceLimit: 40 });
  for (let i = 0; i < 40 && !arena.over; i++) await arena.turn();
}
const rawA: unknown[] = [];
const rows: any[] = [];
for (const { seed, q } of boards) {
  const sentences = spots(q).map((g) => g.sentence), piece = q.state.active.type;
  const original = await judge(piece, sentences), again = await judge(piece, sentences), reversed = await judge(piece, [...sentences].reverse());
  const separate: Record<string, number> = {}; let separateError: string | undefined;
  for (const s of sentences) { const r = await judge(piece, [s]); if ("error" in r) separateError = r.error; else separate[s] = r.judged[s]; }
  rawA.push({ seed, pieceId: q.pieceId, board: q.state.board, sentences, original, again, reversed, separate, separateError });
  rows.push({ seed, pieceId: q.pieceId, sentences, original: (original as any).judged, again: (again as any).judged, reversed: (reversed as any).judged, separate: separateError ? null : separate });
  console.log(JSON.stringify({ part: "A", seed, pieceId: q.pieceId, spots: sentences.length, errors: [original, again, reversed].filter((r: any) => r.error).length + (separateError ? 1 : 0) }));
}
const best = (j: Record<string, number>, order: string[]) => order.reduce((b, s) => (j[s] > j[b] ? s : b), order[0]);
const compare = (a: string, b: string) => {
  const usable = rows.filter((r) => r[a] && r[b]);
  const diffs = usable.flatMap((r) => r.sentences.map((s: string) => Math.abs(r[a][s] - r[b][s])));
  const sameBest = usable.filter((r) => best(r[a], r.sentences) === best(r[b], r.sentences)).length;
  const sorted = [...diffs].sort((x, y) => x - y);
  return { boards: usable.length, judgements: diffs.length, meanAbsDiff: diffs.reduce((s, d) => s + d, 0) / (diffs.length || 1), medianAbsDiff: sorted[Math.floor(sorted.length / 2)] ?? null, over0_2: diffs.filter((d) => d > 0.2).length, sameChosenSpot: sameBest };
};
const summaryA = { recordedAt, protocol: "30 boards from the recorded turn-based spot-clean games (seeds 7/19/42, pieces 1,5,...,37); original twice, reversed with relabelled keys, and each sentence alone", runToRun: compare("original", "again"), reversedOrder: compare("original", "reversed"), separateRequests: compare("original", "separate") };
writeFileSync(out.position, gzipSync(rawA.map((x) => JSON.stringify(x)).join("\n") + "\n"));
writeFileSync(out.positionSummary, JSON.stringify({ ...summaryA, rows }, null, 1) + "\n");
console.log(JSON.stringify({ part: "A", runToRun: summaryA.runToRun, reversedOrder: summaryA.reversedOrder, separateRequests: summaryA.separateRequests }));

// ---------- Part B ----------
const rawB: (Exchange & { seed: number })[] = [];
const games: unknown[] = [];
for (const seed of [3, 11, 23, 31]) {
  const lanes = [framedJev("landing-choice", (b) => send(b), (x) => rawB.push({ ...x, seed })), framedJev("spot-clean", (b) => send(b), (x) => rawB.push({ ...x, seed })), heuristic(0, "Code planner")];
  const arena = new TetrisArena(seed, lanes, "turns", { pieceLimit: 40 });
  for (let i = 0; i < 40 && !arena.over; i++) await arena.turn();
  const game = { seed, pieceLimit: 40, lanes: arena.lanes.map((l) => ({ name: l.contestant.name, framing: l.contestant.id.replace(/^jev-/, ""), pieces: l.game.pieces, lines: l.game.lines, score: l.game.score, status: l.game.status, applied: l.stats.applied, failed: l.stats.failed })) };
  games.push(game);
  console.log(JSON.stringify({ part: "B", ...game }));
  writeFileSync(out.seedsSummary, JSON.stringify({ recordedAt, protocol: "turn-based; seeds 3/11/23/31; 40 pieces; one lane per design; no retries of weak answers", games }, null, 2) + "\n");
}
writeFileSync(out.seedsRaw, gzipSync(rawB.map((x) => JSON.stringify(x)).join("\n") + "\n"));
writeFileSync(out.seeds, rawB.map((x) => JSON.stringify({ seed: x.seed, framing: x.framing, pieceId: x.pieceId, board: x.board, ms: Math.round(x.ms * 10) / 10, ...(x.error ? { error: x.error } : { response: { answers: Object.fromEntries(Object.entries((x.response as any).answers).map(([k, a]: any) => [k, { value: a.value, probabilities: a.probabilities, confidence: a.confidence }])) } }) })).join("\n") + "\n");
