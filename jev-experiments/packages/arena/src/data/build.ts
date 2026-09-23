/**
 * Builds the arena's public data from the recordings: a small index with every
 * card's headline results and uncertainty, and lazily loaded chunks for
 * predictions, cases and replays. Recordings are read in place and never
 * modified. Run by experience-prototypes/scripts/prepare.ts.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { score, argmax } from "../score";
import { bootstrap, bootstrapMany } from "./bootstrap";
import { heuristic, randomPlayer, TetrisArena, type Contestant as Player } from "../tetris";
import { perfectReader } from "../tetris-framings";
import type { ArenaIndex, Card, CardContestant, Estimate, MetricDef, RunSet } from "./schema";
import { readRecord } from "../../../../experience-prototypes/scripts/records";
import { CASES, comparePreferences } from "../../../../cafe-jev/cases";
import { FIELDS, FIELD_LABELS, VALUES, candidates, constraintErrors, drinkName, interpret, type Field } from "../../../../cafe-jev/engine";
import { keywordAnswers, priorAnswers, tokensFor } from "../cafe-baselines";

const here = resolve(import.meta.dir, "../..");
const lab = resolve(here, "../..");
const recordings = resolve(here, "recordings");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const canonical = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
const readJsonl = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
const median = (xs: number[]) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const COLORS = { jev: "#1f6f4a", jev2: "#3f9a6b", jev3: "#86c29a", jev4: "#b7dcc2", laya: "#3d5a99", laya2: "#7a94cf", laya3: "#b3c3e8", qwen: "#9b5a2e", qwen2: "#cf9a70", smol: "#8c6d9f", code: "#6b6b6b", code2: "#9a9a9a", code3: "#c4c4c4" };

function runSet(id: string, label: string, recordedAt: string, protocol: RunSet["protocol"], files: string[], extra: Partial<RunSet> = {}): RunSet {
  return { id, label, recordedAt, source: "recorded", protocol, protocolHash: sha(canonical(protocol)).slice(0, 12), standing: "valid", files, ...extra };
}
const perSeed = (values: { item: string; value: number }[], of?: number): Estimate =>
  ({ value: mean(values.map((v) => v.value)), n: values.length, perItem: values, method: "per-seed", ...(of && values.length < of ? { coverage: { covered: values.length, of } } : {}) });

// ---------------------------------------------------------------- the typed-decisions study
function studyCard(out: string): Card {
  const doc = JSON.parse(readFileSync(resolve(here, "../../experience-prototypes/public/data/local-models.json"), "utf8")).result;
  const models: any[] = doc.models;
  const kind = (id: string) => (id === "jev" ? "hosted" : id === "uniform" || id === "train-prior" ? "code" : "local") as CardContestant["kind"];
  const color = (id: string) => ({ jev: COLORS.jev, "laya-tuned": COLORS.laya, "laya-coreml": COLORS.laya2, "laya-base": COLORS.laya3, "Qwen3-4B-Instruct-2507-4bit": COLORS.qwen, "Qwen3-0.6B-4bit": COLORS.qwen2, "Qwen3-0.6B-4bit-sequence": "#e2c1a3", "SmolLM2-360M-Instruct": COLORS.smol, "train-prior": COLORS.code, uniform: COLORS.code3 }[id] ?? COLORS.code2);
  const rs = runSet("2026-09-20-typed-decisions", "Typed Decisions test split, 10 models", "2026-09-20", { benchmark: "typed-decisions", split: "test", revision: doc.provenance.revision, reference: "mean-of-3-teacher-samples" }, ["experience-prototypes/public/data/local-models.json"]);
  const metrics: MetricDef[] = [
    { id: "agreement", label: "Agrees with reference", unit: "%", better: "higher", axis: "accuracy", help: "Share of decisions whose top answer matches the reference's top answer. The reference is the mean of three samples from a ~4B teacher model, so this is agreement, not correctness; it saturates near 75%." },
    { id: "ece", label: "Calibration error", unit: "", better: "lower", axis: "calibration", help: "Expected calibration error over ten confidence bins: how far stated confidence is from how often the top answer agrees with the reference." },
    { id: "brier", label: "Brier score", unit: "", better: "lower", axis: "calibration", help: "Mean squared difference between the predicted and reference distributions, averaged over options." },
    { id: "confidentWrong", label: "Confident but disagrees", unit: "%", better: "lower", axis: "calibration", help: "Share of decisions where the top answer has at least 70% probability but disagrees with the reference." },
    { id: "latency", label: "Local time per case", unit: "ms", better: "lower", axis: "speed", help: "Median time for all five questions of a case, run sequentially on an Apple M4 Max. Hosted Jev latency includes the network and is not comparable, so it is not shown here." },
  ];
  // Columnar targets, aligned row by row with every prediction chunk.
  const rows: { c: number; q: any; wf: string; type: string }[] = [];
  doc.cases.forEach((c: any, ci: number) => c.questions.forEach((q: any) => rows.push({ c: ci, q, wf: c.workflow, type: q.type })));
  const byCase = (filter: (r: (typeof rows)[number]) => boolean) => {
    const groups = new Map<number, number[]>();
    rows.forEach((r, i) => { if (filter(r)) groups.set(r.c, [...(groups.get(r.c) ?? []), i]); });
    return [...groups.values()];
  };
  // Per-decision facts computed once per model; resampling then only sums them.
  const facts = new Map<string, { hit: Uint8Array; conf: Float64Array; brier: Float64Array }>();
  for (const m of models) {
    const hit = new Uint8Array(rows.length), conf = new Float64Array(rows.length), brier = new Float64Array(rows.length);
    rows.forEach((r, i) => { const one = score([{ prediction: r.q.predictions[m.id], reference: r.q.target }]); hit[i] = one.agreement; conf[i] = one.meanConfidence; brier[i] = one.brier; });
    facts.set(m.id, { hit, conf, brier });
  }
  const stats = (id: string, sample: number[]) => {
    const f = facts.get(id)!; let hits = 0, br = 0, cw = 0;
    const bins = Array.from({ length: 10 }, () => ({ n: 0, conf: 0, hit: 0 }));
    for (const i of sample) {
      hits += f.hit[i]; br += f.brier[i]; if (!f.hit[i] && f.conf[i] >= 0.7) cw++;
      for (let b = 0; b < 10; b++) if (f.conf[i] > b * 0.1 && f.conf[i] <= (b + 1) * 0.1) { bins[b].n++; bins[b].conf += f.conf[i]; bins[b].hit += f.hit[i]; break; }
    }
    const n = sample.length || 1;
    const ece = bins.reduce((e, b) => (b.n ? e + (b.n / n) * Math.abs(b.conf / b.n - b.hit / b.n) : e), 0);
    return { agreement: hits / n, brier: br / n, confidentWrong: cw / n, ece };
  };
  const estimate = (id: string, idx: number[][]): Record<string, Estimate> => {
    const point = stats(id, idx.flat()), n = idx.length;
    const intervals = bootstrapMany(idx, (s) => stats(id, s), 1000);
    const ci = (k: keyof typeof point) => intervals[k];
    const m = models.find((x) => x.id === id);
    return {
      agreement: { value: point.agreement, n, ...ci("agreement"), method: "bootstrap-case" },
      ece: { value: point.ece, n, ...ci("ece"), method: "bootstrap-case" },
      brier: { value: point.brier, n, ...ci("brier"), method: "bootstrap-case" },
      confidentWrong: { value: point.confidentWrong, n, ...ci("confidentWrong"), method: "bootstrap-case" },
      ...(m?.case_latency_ms ? { latency: { value: m.case_latency_ms.median, n, method: "none" as const } } : {}),
    };
  };
  const all = byCase(() => true);
  const results = Object.fromEntries(models.map((m) => [m.id, estimate(m.id, all)]));
  const slices: Card["slices"] = { workflow: {}, type: {} };
  for (const wf of doc.workflows) slices.workflow[wf] = Object.fromEntries(models.map((m) => [m.id, estimate(m.id, byCase((r) => r.wf === wf))]));
  for (const t of ["choice", "score", "noul"]) slices.type[t] = Object.fromEntries(models.map((m) => [m.id, estimate(m.id, byCase((r) => r.type === t))]));
  // Chunks: targets and cases once; one small prediction file per model.
  mkdirSync(join(out, "preds"), { recursive: true });
  const targets = { schema: "arena.targets/1", rows: rows.map((r) => ({ c: r.c, key: r.q.key, type: r.type, wf: r.wf, keys: r.q.keys, target: r.q.target.map((x: number) => round(x)) })) };
  writeFileSync(join(out, "typed-decisions.targets.json"), JSON.stringify(targets));
  writeFileSync(join(out, "typed-decisions.cases.json"), JSON.stringify({ schema: "arena.cases/1", cases: doc.cases.map((c: any) => ({ id: c.id, workflow: c.workflow, state: c.state, questions: c.questions.map((q: any) => ({ key: q.key, type: q.type, instructions: q.instructions, keys: q.keys, options: q.options })) })) }));
  const preds: Record<string, string> = {};
  for (const m of models) { preds[m.id] = `preds/typed-decisions.${m.id}.json`; writeFileSync(join(out, preds[m.id]), JSON.stringify({ schema: "arena.preds/1", contestant: m.id, p: rows.map((r) => r.q.predictions[m.id].map((x: number) => round(x))) })); }
  const defaults = new Set(["jev", "laya-tuned", "Qwen3-4B-Instruct-2507-4bit", "train-prior", "uniform"]);
  return {
    id: "typed-decisions", title: "Typed decisions over shared state", question: "Given one piece of state, how well do models answer five typed questions about it, and how honest is their confidence?",
    family: "judgement-set", reference: "soft-teacher", metrics, primary: "agreement",
    contestants: models.map((m) => ({ id: m.id, name: m.name, short: m.name.split(" · ")[0], kind: kind(m.id), model: m.url ? m.name.split(" · ")[0] : undefined, policy: m.name.split(" · ")[1], color: color(m.id), default: defaults.has(m.id), runSets: [rs.id] })),
    results, slices,
    provenance: `Agreement with a soft reference · ${doc.cases.length} cases × 5 questions · Typed Decisions test split (${doc.provenance.license}, rev ${doc.provenance.revision.slice(0, 7)}) · local models on ${doc.hardware}, Jev via AI Gateway · recorded 20 Sep 2026 · 95% case-bootstrap intervals`,
    chunks: { preds, targets: "typed-decisions.targets.json", cases: "typed-decisions.cases.json" },
    lenses: ["bars", "scatter", "reliability", "table", "case"],
    protocolGroups: [{ hash: rs.protocolHash, label: rs.label, runSets: [rs.id] }],
  };
}

// ---------------------------------------------------------------- Tetris, turns
/** Code players are deterministic: cache their games under a hash of the engine and player source. */
const sourceHash = sha(["../../../../live-worlds/tetris/engine.ts", "../tetris.ts", "../tetris-framings.ts", "../../../../live-worlds/tetris/session.ts"].map((f) => readFileSync(resolve(import.meta.dir, f), "utf8")).join("\n")).slice(0, 16);
const cacheDir = resolve(here, ".cache");
async function cached<T>(name: string, compute: () => T | Promise<T>): Promise<T> {
  const file = join(cacheDir, `${name}.${sourceHash}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const value = await compute(); mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, JSON.stringify(value)); return value;
}
async function simulateTurns(player: () => Player, seeds: number[]) {
  const out: Record<number, { lines: number; pieces: number; over: boolean }> = {};
  for (const seed of seeds) {
    const a = new TetrisArena(seed, [player()], "turns", { pieceLimit: 40 });
    for (let i = 0; i < 40 && !a.over; i++) await a.turn();
    const g = a.lanes[0].game; out[seed] = { lines: g.lines, pieces: g.pieces, over: g.status === "over" };
  }
  return out;
}
function simulateRealtime(player: () => Player, seeds: number[]) {
  const out: Record<number, { lines: number; pieces: number; over: boolean; worldMs: number }> = {};
  for (const seed of seeds) {
    const a = new TetrisArena(seed, [player()], "realtime", { pieceLimit: 40 });
    while (!a.over && a.clockMs < 240_000) a.step();
    a.stop(); const g = a.lanes[0].game; out[seed] = { lines: g.lines, pieces: g.pieces, over: g.status === "over", worldMs: a.clockMs };
  }
  return out;
}
const GAME_METRICS: MetricDef[] = [
  { id: "lines", label: "Lines cleared", unit: "lines", better: "higher", axis: "outcome", help: "Lines cleared in a 40-piece game, one dot per seed. Every contestant gets the same pieces in the same order." },
  { id: "pieces", label: "Pieces placed", unit: "pieces", better: "higher", axis: "outcome", help: "Pieces placed before the 40-piece limit or topping out." },
  { id: "toppedOut", label: "Games topped out", unit: "count", better: "lower", axis: "outcome", help: "Games that ended because the stack reached the top before 40 pieces." },
  { id: "decisionMs", label: "Median decision time", unit: "ms", better: "lower", axis: "speed", help: "Median time from question to usable answer across the contestant's decisions. Code players answer instantly." },
];

async function turnsCard(out: string): Promise<Card> {
  const a = readJsonl(join(recordings, "tetris-framings.replay.jsonl")), aSum = JSON.parse(readFileSync(join(recordings, "tetris-framings-summary.json"), "utf8"));
  const b = readJsonl(join(recordings, "turns-more-seeds.replay.jsonl")), bSum = JSON.parse(readFileSync(join(recordings, "turns-more-seeds-summary.json"), "utf8"));
  const protocol = { game: "tetris", timing: "turns", pieceLimit: 40, lanes: "one per design, same arena", transport: "serial, patient retries", weakAnswers: "never retried" };
  const rsA = runSet("2026-09-22-tetris-turns-a", "Turns · seeds 7, 19, 42", "2026-09-22", protocol, ["packages/arena/recordings/tetris-framings.replay.jsonl"]);
  const rsB = runSet("2026-09-23-tetris-turns-b", "Turns · seeds 3, 11, 23, 31", "2026-09-23", protocol, ["packages/arena/recordings/turns-more-seeds.replay.jsonl"]);
  const rsCode = { ...runSet("computed-tetris-turns-code", "Code players, computed at build", new Date().toISOString().slice(0, 10), protocol, []), source: "computed" as const };
  const seeds = [7, 19, 42, 3, 11, 23, 31];
  const games: Record<string, Record<number, { lines: number; pieces: number; over: boolean; ms: number[] }>> = {};
  for (const [sum, rows] of [[aSum, a], [bSum, b]] as const) for (const g of sum.games) for (const lane of g.lanes) {
    const framing = lane.framing as string; if (!framing || framing.startsWith("Code")) continue;
    const id = `jev.${framing}`;
    (games[id] ??= {})[g.seed] = { lines: lane.lines, pieces: lane.pieces, over: lane.status === "over", ms: rows.filter((x: any) => x.seed === g.seed && x.framing === framing && !x.error).map((x: any) => x.ms) };
  }
  const code = {
    "code.planner": await cached(`turns-planner-${seeds.join("-")}`, () => simulateTurns(() => heuristic(0), seeds)),
    "code.reader": await cached(`turns-reader-${seeds.join("-")}`, () => simulateTurns(() => perfectReader(), seeds)),
    "code.random": await cached(`turns-random-${seeds.join("-")}`, () => simulateTurns(() => randomPlayer(1), seeds)),
  };
  for (const [id, per] of Object.entries(code)) games[id] = Object.fromEntries(Object.entries(per).map(([s, v]) => [s, { ...v, ms: [0] }]));
  const results: Card["results"] = {};
  for (const [id, per] of Object.entries(games)) {
    const covered = seeds.filter((s) => per[s]);
    results[id] = {
      lines: perSeed(covered.map((s) => ({ item: String(s), value: per[s].lines })), seeds.length),
      pieces: perSeed(covered.map((s) => ({ item: String(s), value: per[s].pieces })), seeds.length),
      toppedOut: { value: covered.filter((s) => per[s].over).length, n: covered.length, method: "count" },
      decisionMs: { value: median(covered.flatMap((s) => per[s].ms)), n: covered.flatMap((s) => per[s].ms).length, method: "none" },
    };
  }
  // Replay chunks: one per recorded contestant and seed.
  mkdirSync(join(out, "replay"), { recursive: true });
  const replay: Record<string, Record<string, string>> = {};
  for (const rows of [a, b]) for (const x of rows) {
    const id = `jev.${x.framing}`, path = `replay/turns.${x.framing}.${x.seed}.json`;
    (replay[id] ??= {})[String(x.seed)] = path;
  }
  for (const [id, per] of Object.entries(replay)) for (const [seed, path] of Object.entries(per)) {
    const framing = id.slice(4), rows = [...a, ...b].filter((x: any) => x.framing === framing && String(x.seed) === seed);
    writeFileSync(join(out, path), JSON.stringify({ schema: "arena.replay.turns/1", framing, seed: +seed, exchanges: rows }));
  }
  const c = (id: string, name: string, short: string, kind: CardContestant["kind"], color: string, def: boolean, runSets: string[], policy?: string): CardContestant => ({ id, name, short, kind, color, default: def, runSets, model: kind === "hosted" ? "typesafe-ai/jev" : undefined, policy });
  return {
    id: "tetris-turns", title: "Where should the piece land?", question: "Three ways of asking Jev the same Tetris question, with the world paused until every contestant answers.",
    family: "game", reference: "world-outcome", metrics: GAME_METRICS, primary: "lines",
    contestants: [
      c("jev.spot-clean", "Jev · judge each spot", "Judge each spot", "hosted", COLORS.jev, true, [rsA.id, rsB.id], "one sentence per distinct spot, batched yes/no; code picks the best"),
      c("jev.spot-score", "Jev · rate each spot 0–3", "Rate each spot", "hosted", COLORS.jev3, false, [rsA.id], "one sentence per spot, 0–3 rating"),
      c("jev.landing-choice", "Jev · pick one landing", "Pick one landing", "hosted", COLORS.qwen, true, [rsA.id, rsB.id], "every landing as JSON features in one choice"),
      c("code.planner", "Code planner", "Code planner", "code", COLORS.code, true, [rsCode.id], "hand-written landing heuristic"),
      c("code.reader", "Perfect reader of the sentences", "Perfect reader", "code", COLORS.code2, false, [rsCode.id], "reads the spot sentences with a fixed rule; bounds what the words allow"),
      c("code.random", "Random landing", "Random", "code", COLORS.code3, false, [rsCode.id], "uniform over reachable landings"),
    ],
    results, items: seeds.map((s) => ({ id: String(s), label: `Seed ${s}` })),
    provenance: `Lines cleared in 40-piece turn games · 7 seeds (7, 19, 42 on 22 Sep; 3, 11, 23, 31 on 23 Sep 2026) · one lane per design in the same arena · typesafe-ai/jev via AI Gateway · rating each spot recorded on 3 seeds only · code players computed at build`,
    chunks: { replay },
    lenses: ["bars", "per-item", "scatter", "table", "board"],
    protocolGroups: [{ hash: rsA.protocolHash, label: "Turns, 40 pieces", runSets: [rsA.id, rsB.id, rsCode.id] }],
  };
}

// ---------------------------------------------------------------- Tetris, real time
async function realtimeCard(out: string): Promise<Card> {
  const load = (f: string) => JSON.parse(readFileSync(join(recordings, f), "utf8"));
  const runs = [{ file: "realtime.replay.json", retry: "fixed-400ms", date: "2026-09-22", id: "2026-09-22-tetris-realtime-a" }, { file: "realtime-2.replay.json", retry: "backoff-0.4-4s", date: "2026-09-23", id: "2026-09-23-tetris-realtime-b" }];
  const base = { game: "tetris", timing: "realtime", pieceLimit: 40, lanes: "one game per design", inFlight: 1, attempts: "2 within 4 s", superseded: "dropped" };
  const sets = runs.map((r) => runSet(r.id, r.retry === "fixed-400ms" ? "Real time · retries every 400 ms" : "Real time · backs off 0.4–4 s", r.date, { ...base, retry: r.retry }, [`packages/arena/recordings/${r.file}`]));
  const code = await cached("realtime-planner-7-19-42", () => simulateRealtime(() => heuristic(0), [7, 19, 42]));
  const results: Card["results"] = {}, replay: Record<string, Record<string, string>> = {};
  const contestants: CardContestant[] = [];
  const names: Record<string, [string, string]> = { "landing-choice": ["Jev · pick one landing", "Pick one landing"], "spot-clean": ["Jev · judge each spot", "Judge each spot"], "spot-clean-cached": ["Jev · judge each spot, remembering all", "Remember all"], "spot-clean-confident": ["Jev · judge each spot, remembering confident", "Remember confident"] };
  const colors: Record<string, string> = { "landing-choice": COLORS.qwen, "spot-clean": COLORS.jev, "spot-clean-cached": COLORS.jev4, "spot-clean-confident": COLORS.jev2 };
  runs.forEach((r, ri) => {
    const doc = load(r.file), suffix = r.retry === "fixed-400ms" ? "fixed" : "backoff";
    const designs = [...new Set(doc.games.map((g: any) => g.design))] as string[];
    for (const d of designs) {
      const id = `jev.${d}@${suffix}`, games = doc.games.filter((g: any) => g.design === d);
      results[id] = {
        lines: perSeed(games.map((g: any) => ({ item: String(g.seed), value: g.lines }))),
        gameTime: perSeed(games.map((g: any) => ({ item: String(g.seed), value: g.worldMs / 1000 }))),
        failed: perSeed(games.map((g: any) => ({ item: String(g.seed), value: g.failed }))),
        decisionMs: { value: median(games.flatMap((g: any) => g.events.filter((e: any) => e.status === "applied" && e.latencyMs != null).map((e: any) => e.latencyMs))), n: games.length, method: "none" },
        memory: perSeed(games.map((g: any) => ({ item: String(g.seed), value: g.memoryHits ?? 0 }))),
      };
      for (const g of games) { const path = `replay/realtime.${d}.${suffix}.${g.seed}.json`; (replay[id] ??= {})[String(g.seed)] = path; writeFileSync(join(out, path), JSON.stringify({ schema: "arena.replay.timed/1", retryPolicy: suffix, seed: g.seed, events: g.events })); }
      contestants.push({ id, name: `${names[d][0]} · ${suffix === "fixed" ? "fixed retries" : "backoff"}`, short: names[d][1], kind: "hosted", model: "typesafe-ai/jev", policy: `${names[d][1].toLowerCase()}; ${suffix === "fixed" ? "re-asks every 400 ms after a failure" : "backs off 0.4–4 s after a failure"}`, color: colors[d], default: suffix === "backoff" && d !== "spot-clean-cached", runSets: [sets[ri].id] });
    }
  });
  results["code.planner"] = { lines: perSeed(Object.entries(code).map(([s, v]) => ({ item: s, value: v.lines }))), gameTime: perSeed(Object.entries(code).map(([s, v]) => ({ item: s, value: v.worldMs / 1000 }))), failed: perSeed(Object.keys(code).map((s) => ({ item: s, value: 0 }))), decisionMs: { value: 0, n: 3, method: "none" }, memory: perSeed(Object.keys(code).map((s) => ({ item: s, value: 0 }))) };
  contestants.push({ id: "code.planner", name: "Code planner", short: "Code planner", kind: "code", color: COLORS.code, default: true, runSets: [], policy: "hand-written landing heuristic, instant" });
  const metrics: MetricDef[] = [GAME_METRICS[0], { id: "gameTime", label: "Game time for 40 pieces", unit: "s", better: "lower", axis: "speed", help: "World time to place 40 pieces. Gravity never waits, so slow or failed answers stretch the game." }, { id: "failed", label: "Failed requests", unit: "count", better: "lower", axis: "cost", help: "Requests that failed and were asked again, almost all 429 rate limits." }, GAME_METRICS[3], { id: "memory", label: "Judgements reused", unit: "count", better: "higher", axis: "cost", help: "Spot judgements answered from memory instead of a request." }];
  return {
    id: "tetris-realtime", title: "Does the better question survive real time?", question: "The same designs with gravity running: slow answers cost pieces, and rate limits cost time.",
    family: "game", reference: "world-outcome", metrics, primary: "lines", contestants, results,
    items: [7, 19, 42].map((s) => ({ id: String(s), label: `Seed ${s}` })),
    provenance: "Lines cleared in 40-piece real-time games · seeds 7, 19, 42 · one game per design, one request in flight · two protocols: run 1 re-asks every 400 ms (22 Sep), run 2 backs off 0.4–4 s (23 Sep 2026) · typesafe-ai/jev via AI Gateway · code planner computed at build",
    chunks: { replay }, lenses: ["bars", "per-item", "scatter", "table", "board"],
    protocolGroups: sets.map((s) => ({ hash: s.protocolHash, label: s.label, runSets: [s.id] })),
  };
}

// ---------------------------------------------------------------- Café Jev
/**
 * The 102 authored café cases. Jev's recorded answers and two code baselines go
 * through the same café engine. The reference is the authored expectation for
 * each case, written before the calls but not independently annotated.
 */
export function cafeCard(out: string): Card {
  const record = readRecord(resolve(lab, "cafe-jev/cafe.jsonl")), doc = record.result, recordedOn = String(record.manifest.created).slice(0, 10);
  const rows: any[] = doc.rows;
  const gold = (c: (typeof CASES)[number], f: Field) => { const e = c.expected[f]; return e.status === "unknown" || e.status === "conflicting" ? e.status : `${e.status}_${e.value}`; };
  // A per-field prior fitted on these same cases: how often each token is the expected one.
  const prior = Object.fromEntries(FIELDS.map((f) => {
    const counts = Object.fromEntries(tokensFor(f).map((t) => [t, 0]));
    for (const c of CASES) counts[gold(c, f)]++;
    return [f, Object.fromEntries(Object.entries(counts).map(([t, n]) => [t, n / CASES.length]))];
  })) as Record<Field, Record<string, number>>;
  const contestants = [
    { id: "jev", name: "Jev · recorded", short: "Jev", kind: "hosted" as const, model: "typesafe-ai/jev", policy: "seven typed preference questions plus a source turn each; code checks recipes", color: COLORS.jev },
    { id: "code.keywords", name: "Keyword reader", short: "Keywords", kind: "code" as const, policy: "keyword and negation rules written after reading these cases and their expected answers; an optimistic ceiling for rules, not a held-out baseline; one-hot answers", color: COLORS.code },
    { id: "code.prior", name: "Most common answer", short: "Prior", kind: "code" as const, policy: "answers each field with its most common expected token across these same cases; optimistic because it is fitted on the evaluation set", color: COLORS.code3 },
  ];
  const caseRows = CASES.map((c) => ({ c, row: rows.find((r) => r.id === c.id)! }));
  if (caseRows.some((x) => !x.row)) throw new Error("A declared café case has no recorded row");
  const answersFor = (id: string, c: (typeof CASES)[number], row: any) => id === "jev" ? row.response.answers : id === "code.keywords" ? keywordAnswers(c.input) : priorAnswers(c.input, prior);
  type Outcome = { exact: boolean; fields: number; feasibleExact: boolean; violation: boolean; suggested: string | null; tokens: Record<string, string>; dists: number[][] };
  const outcomes: Record<string, Outcome[]> = {};
  for (const ct of contestants) outcomes[ct.id] = caseRows.map(({ c, row }) => {
    const answers = answersFor(ct.id, c, row), decision = interpret({ answers } as any, c.input);
    const cmp = comparePreferences(decision.preferences, c.expected);
    const expectedFeasible = candidates(c.expected, c.input.inventory);
    const same = (a: any[], b: any[]) => JSON.stringify(a.map((r) => JSON.stringify(r)).sort()) === JSON.stringify(b.map((r) => JSON.stringify(r)).sort());
    return {
      exact: cmp.exact, fields: FIELDS.filter((f) => cmp.perField[f]).length, feasibleExact: same(decision.feasible, expectedFeasible),
      violation: Boolean(decision.suggested && constraintErrors(decision.suggested, c.expected, c.input.inventory).length),
      suggested: decision.suggested ? drinkName(decision.suggested) : null,
      tokens: Object.fromEntries(FIELDS.map((f) => [f, String(answers[f]?.value ?? "unknown")])),
      dists: FIELDS.map((f) => { const p = answers[f]?.probabilities ?? { [String(answers[f]?.value)]: 1 }; return tokensFor(f).map((t) => Number(p[t] ?? 0)); }),
    };
  });
  const metrics: MetricDef[] = [
    { id: "exact", label: "Understood every preference", unit: "%", better: "higher", axis: "accuracy", help: "Share of cases where all seven interpreted preferences (value and strength) match the authored expectation." },
    { id: "fields", label: "Preferences right", unit: "%", better: "higher", axis: "accuracy", help: "Share of the seven preference fields per case that match the authored expectation after the café engine interprets the answer." },
    { id: "feasible", label: "Right set of drinks", unit: "%", better: "higher", axis: "accuracy", help: "Share of cases where the interpreted preferences allow exactly the drinks the authored expectation allows." },
    { id: "violation", label: "Served a drink that breaks a requirement", unit: "%", better: "lower", axis: "outcome", help: "Share of cases where the suggested drink, after the café engine's own checks, still breaks a requirement in the authored expectation (for example dairy for a dairy-free customer)." },
    { id: "ece", label: "Calibration error", unit: "", better: "lower", axis: "calibration", help: "Expected calibration error of the raw preference answers over ten confidence bins. The code baselines answer with certainty, so their error equals their miss rate." },
    { id: "confidentWrong", label: "Confident but wrong", unit: "%", better: "lower", axis: "calibration", help: "Share of raw preference answers given with at least 70% probability that differ from the authored expectation." },
  ];
  const group = (c: (typeof CASES)[number]) => (c.category === "finite-partial-state" ? "templated" : "hand-written");
  const stats = (id: string, idx: number[]) => {
    const o = outcomes[id], n = idx.length || 1;
    const answers = idx.flatMap((i) => FIELDS.map((f, k) => ({ prediction: o[i].dists[k].some((x) => x > 0) ? o[i].dists[k] : tokensFor(f).map(() => 1), reference: tokensFor(f).map((t) => (t === gold(CASES[i], f) ? 1 : 0)) })));
    const card = score(answers);
    return { exact: idx.filter((i) => o[i].exact).length / n, fields: idx.reduce((s, i) => s + o[i].fields, 0) / (n * FIELDS.length), feasible: idx.filter((i) => o[i].feasibleExact).length / n, violation: idx.filter((i) => o[i].violation).length / n, ece: card.ece, confidentWrong: card.confidentButWrong / (card.decisions || 1) };
  };
  const estimate = (id: string, filter: (c: (typeof CASES)[number]) => boolean) => {
    const idx = CASES.map((c, i) => (filter(c) ? i : -1)).filter((i) => i >= 0);
    const point = stats(id, idx), ci = bootstrapMany(idx.map((i) => [i]), (s) => stats(id, s), 1000);
    return Object.fromEntries(Object.entries(point).map(([k, v]) => [k, { value: v, n: idx.length, ...ci[k as keyof typeof point], method: "bootstrap-case" as const }]));
  };
  const results = Object.fromEntries(contestants.map((ct) => [ct.id, estimate(ct.id, () => true)]));
  const slices: Card["slices"] = { workflow: {} };
  for (const g of ["templated", "hand-written"]) slices.workflow[g] = Object.fromEntries(contestants.map((ct) => [ct.id, estimate(ct.id, (c) => group(c) === g)]));
  // Chunks in the typed-decisions shape, so the calibration and case views work unchanged: one row per case × field.
  const targets = { schema: "arena.targets/1", rows: CASES.flatMap((c, ci) => FIELDS.map((f) => ({ c: ci, key: f, type: f, wf: group(c), keys: tokensFor(f), target: tokensFor(f).map((t) => (t === gold(c, f) ? 1 : 0)) }))) };
  mkdirSync(join(out, "preds"), { recursive: true });
  writeFileSync(join(out, "cafe.targets.json"), JSON.stringify(targets));
  const option = (f: Field, t: string) => t === "unknown" ? "not stated" : t === "conflicting" ? "contradictory" : `${t.startsWith("required") ? "must be" : "would like"} ${VALUES[f][t.replace(/^(required|preferred)_/, "")]}`;
  writeFileSync(join(out, "cafe.cases.json"), JSON.stringify({ schema: "arena.cases/1", cases: CASES.map((c, ci) => ({
    id: c.id, workflow: group(c),
    state: { customer: c.input.transcript.map((t) => t.text), suggested: Object.fromEntries(contestants.map((ct) => [ct.short, outcomes[ct.id][ci].suggested ?? "nothing"])), breaksARequirement: contestants.filter((ct) => outcomes[ct.id][ci].violation).map((ct) => ct.short) },
    questions: FIELDS.map((f) => ({ key: f, type: FIELD_LABELS[f].toLowerCase(), instructions: FIELD_LABELS[f], keys: tokensFor(f), options: tokensFor(f).map((t) => option(f, t)) })),
  })) }));
  const preds: Record<string, string> = {};
  for (const ct of contestants) { preds[ct.id] = `preds/cafe.${ct.id}.json`; writeFileSync(join(out, preds[ct.id]), JSON.stringify({ schema: "arena.preds/1", contestant: ct.id, p: outcomes[ct.id].flatMap((o) => o.dists.map((d) => d.map((x) => round(x)))) })); }
  const rs = runSet(`${recordedOn}-cafe-jev`, "Café Jev, 102 authored cases", recordedOn, { benchmark: "cafe-jev", menu: doc.menuRevision, contract: "cafe-jev-turn-v1", cases: 102 }, ["cafe-jev/cafe.jsonl"]);
  return {
    id: "cafe", title: "What does the customer actually want?", question: "A customer describes a drink. Each contestant answers seven typed questions about their preferences; the café's own code then picks a legal recipe.",
    family: "judgement-set", reference: "authored-labels", metrics, primary: "exact",
    contestants: contestants.map((ct) => ({ ...ct, default: true, runSets: ct.id === "jev" ? [rs.id] : [] })),
    results, slices, facetLabels: { workflow: "Cases" },
    provenance: `Agreement with authored expectations · 102 café cases (81 templated one-sentence states, 21 hand-written requests) · expectations written before the calls, not independently annotated · typesafe-ai/jev via AI Gateway, recorded ${new Date(recordedOn).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} · code baselines computed at build; the keyword rules were written after reading these cases and the most-common-answer baseline is fitted on them, so both are optimistic · 95% case-bootstrap intervals`,
    chunks: { preds, targets: "cafe.targets.json", cases: "cafe.cases.json" },
    lenses: ["bars", "scatter", "reliability", "table", "case"],
    protocolGroups: [{ hash: rs.protocolHash, label: rs.label, runSets: [rs.id] }],
  };
}

// ---------------------------------------------------------------- robustness
function robustnessCard(out: string): Card {
  const doc = JSON.parse(readFileSync(join(recordings, "robustness-position-summary.json"), "utf8"));
  const rows: any[] = doc.rows;
  const variants: [string, string, string][] = [["again", "Asked again, same order", COLORS.code2], ["reversed", "Reversed order, labels reassigned", COLORS.jev2], ["separate", "Each sentence asked alone", COLORS.qwen]];
  const results: Card["results"] = {};
  for (const [key] of variants) {
    const usable = rows.filter((r) => r.original && r[key]);
    const perBoard = usable.map((r) => r.sentences.map((s: string) => Math.abs(r.original[s] - r[key][s])));
    const best = (j: Record<string, number>, order: string[]) => order.reduce((b, s) => (j[s] > j[b] ? s : b), order[0]);
    const all = perBoard.flat();
    results[key] = {
      meanChange: { value: mean(all), n: usable.length, ...bootstrap(perBoard, (s) => mean(s), 1000), method: "bootstrap-case" },
      moved: { value: all.filter((d: number) => d > 0.2).length / (all.length || 1), n: usable.length, ...bootstrap(perBoard, (s) => s.filter((d) => d > 0.2).length / (s.length || 1), 1000), method: "bootstrap-case" },
      sameChoice: { value: usable.filter((r) => best(r.original, r.sentences) === best(r[key], r.sentences)).length / (usable.length || 1), n: usable.length, method: "count" },
    };
  }
  writeFileSync(join(out, "robustness.rows.json"), JSON.stringify({ schema: "arena.robustness/1", rows }));
  return {
    id: "spot-robustness", title: "Does Jev's judgement move when nothing meaningful changes?", question: "The same 30 boards asked again, in reverse order, and one spot per request.",
    family: "robustness", reference: "self-consistency",
    metrics: [
      { id: "meanChange", label: "Mean change in P(clean)", unit: "", better: "lower", axis: "robustness", help: "Average absolute change in a spot's judged probability compared with the original batched request." },
      { id: "moved", label: "Judgements moved by more than 0.2", unit: "%", better: "lower", axis: "robustness", help: "Share of spot judgements that changed by more than 0.2." },
      { id: "sameChoice", label: "Same chosen spot", unit: "%", better: "higher", axis: "robustness", help: "Share of boards where code would pick the same spot from the new judgements." },
    ],
    primary: "meanChange",
    contestants: variants.map(([id, name, color]) => ({ id, name, short: name, kind: "hosted" as const, model: "typesafe-ai/jev", policy: "judge each spot", color, default: true, runSets: ["2026-09-23-spot-clean-position"] })),
    results, provenance: `Judge each spot · 30 boards from the recorded turn games (seeds 7, 19, 42) · ${rows.reduce((s, r) => s + r.sentences.length, 0)} judgements · recorded 23 Sep 2026 · 95% board-bootstrap intervals`,
    chunks: { rows: "robustness.rows.json" }, lenses: ["bars", "table"],
    protocolGroups: [{ hash: sha("robustness-position").slice(0, 12), label: "Position and batching", runSets: ["2026-09-23-spot-clean-position"] }],
  };
}

export async function buildArena(outDir: string) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const cards = [await turnsCard(outDir), await realtimeCard(outDir), robustnessCard(outDir), studyCard(outDir), cafeCard(outDir)];
  const runSets: RunSet[] = [
    runSet("2026-09-20-typed-decisions", "Typed Decisions test split, 10 models", "2026-09-20", {}, ["experience-prototypes/public/data/local-models.json"]),
    runSet("2026-09-22-tetris-turns-busy", "First turn attempt (provider busy)", "2026-09-22", { game: "tetris", timing: "turns" }, ["packages/arena/recordings/attempt-1-provider-busy.jsonl.gz"], { standing: "availability-only", note: "Sent three requests at once and hit provider capacity; 93 of 127 failed. Measures availability, not the designs." }),
  ];
  const index: ArenaIndex = { schema: "arena.index/1", generatedAt: new Date().toISOString(), runSets, cards };
  writeFileSync(join(outDir, "index.json"), JSON.stringify(index));
  return index;
}

if (import.meta.main) {
  const out = resolve(here, "../../experience-prototypes/public/arena");
  const index = await buildArena(out);
  console.log(JSON.stringify({ cards: index.cards.map((c) => c.id), bytes: readFileSync(join(out, "index.json")).length }));
}
