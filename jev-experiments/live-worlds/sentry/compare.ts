/**
 * Compares the free sentry with Jev's recorded answers on the same blocks, and writes the two
 * small files the scene imports:
 *
 *   scene-jev.json — Jev's five scores for every block the scene can show, keyed by page, place
 *                    and text, with each batch's latency, tokens, cost and the exact request.
 *   compare.json   — injections caught and harmless blocks flagged, free against Jev, per set.
 *
 * Jev's answers are only compared and shown, never trained on (TypeSafe MCA §2.3(b)).
 *
 *   bun live-worlds/sentry/compare.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { batchScores, blockKey } from "./jev";
import { RISK_THRESHOLD, score, type Block, type Scores, type Weights } from "./model";
import { HARD_TRAPS, PAGES, TRAPS } from "./pages";
import { realRows } from "./real";
import { WILD } from "./wild";
import { WILD2 } from "./wild2";
import weightsJson from "./weights.json";

const W = weightsJson as Weights;

type Rec = {
  id: string;
  set: "scene" | "eval";
  keys: string[];
  at: string;
  status: string;
  model: string;
  servedBy: string | null;
  latencyMs: number;
  inputTokens: number | null;
  costUsd: number | null;
  request: unknown;
  answers: Record<string, { value?: unknown }>;
};

const recs = readFileSync(new URL("./recordings/jev.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as Rec)
  .filter((r) => r.status === "ok");

// Scene: one entry per block, pointing at its batch's receipt.
const scene: Record<string, { scores: Scores; batch: string }> = {};
const batches: Record<string, Pick<Rec, "at" | "model" | "servedBy" | "latencyMs" | "inputTokens" | "costUsd" | "request" | "answers">> = {};

for (const r of recs.filter((x) => x.set === "scene")) {
  batchScores(r.answers, r.keys.length).forEach((s, i) => (scene[r.keys[i]] = { scores: s, batch: r.id }));
  batches[r.id] = { at: r.at, model: r.model, servedBy: r.servedBy, latencyMs: r.latencyMs, inputTokens: r.inputTokens, costUsd: r.costUsd, request: r.request, answers: r.answers };
}

// Eval: Jev's risk for every held-out row, by id.
const jevRisk = new Map<string, number>();

for (const r of recs.filter((x) => x.set === "eval")) r.keys.forEach((k, i) => jevRisk.set(k, Number(r.answers[`b${i}_risk`]?.value ?? 0)));

type Row = { id: string; block: Block; injection: boolean };

function tally(rows: Row[], jev: (r: Row) => number | undefined) {
  const caught = (pick: (r: Row) => number | undefined, inj: boolean) => {
    const xs = rows.filter((r) => r.injection === inj);
    const hit = xs.filter((r) => (pick(r) ?? 0) >= RISK_THRESHOLD).length;

    return xs.length ? `${hit}/${xs.length}` : "—";
  };
  const free = (r: Row) => score(W, r.block).risk;

  return {
    free: { injectionsCaught: caught(free, true), harmlessFlagged: caught(free, false) },
    jev: { injectionsCaught: caught(jev, true), harmlessFlagged: caught(jev, false) },
  };
}

const real = realRows().filter((r) => r.split === "test");
const sources = [...new Set(real.map((r) => r.source))];
const evalRows = {
  ...Object.fromEntries(
    sources.map((s) => [
      s,
      real
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => r.source === s)
        .map(({ r, i }) => ({ id: `real:${r.source}:${i}`, block: { text: r.text, where: "visible" as const }, injection: r.injection })),
    ]),
  ),
  wild: WILD.map((w, i) => ({ id: `wild:${i}`, block: { text: w.text, where: w.where }, injection: w.injection })),
  wild2: WILD2.map((w, i) => ({ id: `wild2:${i}`, block: { text: w.text, where: w.where }, injection: w.injection })),
};

// The scene's own blocks: harmless page blocks, the default traps and the hard traps, per page.
const sceneRows = (pick: "page" | "traps" | "hard"): Row[] =>
  PAGES.flatMap((p) =>
    (pick === "page" ? p.blocks.map((b) => ({ text: b.text, where: b.where })) : (pick === "traps" ? TRAPS : HARD_TRAPS).map((t) => ({ text: t.text, where: t.where }))).map((b) => ({
      id: blockKey(p.id, b),
      block: b,
      injection: pick !== "page",
    })),
  );

const compare = {
  generated: new Date().toISOString().slice(0, 10),
  threshold: RISK_THRESHOLD,
  sets: {
    ...Object.fromEntries(Object.entries(evalRows).map(([k, rows]) => [k, tally(rows, (r) => jevRisk.get(r.id))])),
    "scene: page blocks": tally(sceneRows("page"), (r) => scene[r.id]?.scores.risk),
    "scene: default traps": tally(sceneRows("traps"), (r) => scene[r.id]?.scores.risk),
    "scene: hard traps": tally(sceneRows("hard"), (r) => scene[r.id]?.scores.risk),
  },
  spend: {
    requests: recs.length,
    inputTokens: recs.reduce((a, r) => a + (r.inputTokens ?? 0), 0),
    costUsd: Math.round(recs.reduce((a, r) => a + (r.costUsd ?? 0), 0) * 1e5) / 1e5,
    medianLatencyMs: [...recs.map((r) => r.latencyMs)].sort((a, b) => a - b)[Math.floor(recs.length / 2)],
    recordedOn: recs[0]?.at.slice(0, 10),
  },
};

writeFileSync(new URL("./scene-jev.json", import.meta.url), JSON.stringify({ blocks: scene, batches }) + "\n");
writeFileSync(new URL("./compare.json", import.meta.url), JSON.stringify(compare, null, 1) + "\n");
console.log(JSON.stringify(compare, null, 1));
