/**
 * Scores every free decider against the hand-written gold sets (gold/), never against Jev.
 *
 *   cd jev-experiments/experience-prototypes
 *   bun ../packages/arena/scripts/free-model-evaluate.ts jobs OUT_DIR      # teacher jobs for the gold items
 *   teacher_fireworks.py OUT_DIR/gold-lines.jsonl OUT_DIR/labels-gold-lines.jsonl  (and gold-rumours)
 *   bun ../packages/arena/scripts/free-model-evaluate.ts score TEACHER_DIR [QWEN3_4B_DIR]  # results.json
 *
 * Models: the student (this package), MobileBERT zero-shot (Win over's previous free model), the
 * MiniLM similarity formula (the rumour mill's previous free model), the shipped teacher
 * (Qwen3.8-2.4T-A95B) and, for comparison, the small local teacher first tried (Qwen3-4B).
 */
import { pipeline } from "@huggingface/transformers";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerWithNli, NLI_MODEL, type ZeroShot } from "../src/decide/nli";
import { placeIn } from "../../../live-worlds/rumour/places";
import { allProfiles, jevRequest, type Profile } from "../../../live-worlds/rumour/profiles";
import { features, profileDist, type Vectors } from "../../../live-worlds/rumour/similarity";
import vectorsDoc from "../../../live-worlds/rumour/vectors.json";
import { lineRequest, type Answer, type Event } from "../../../live-worlds/win-over/decide";
import { EMBED_MODEL, eventText, INTENTS, RUMOUR_ACTIONS } from "../../../live-worlds/free-model/features";
import { teacherLineRequest } from "../../../live-worlds/free-model/teacher-requests";
import goldLines from "../../../live-worlds/free-model/gold/win-over-lines.json";
import goldRumours from "../../../live-worlds/free-model/gold/rumours.json";

type GoldLine = { kind: Event["kind"]; text: string; intent: string; honest: boolean | null; friendly: boolean | null };
type GoldRumour = { text: string; place: string | null } & Record<"A" | "B" | "C" | "D", string[]>;

const lines = goldLines.lines as GoldLine[];
const rumours = goldRumours.rumours as GoldRumour[];
const PROFILE_IDS = ["A", "B", "C", "D"] as const;

function profileFor(id: (typeof PROFILE_IDS)[number]): Profile {
  const g = goldRumours.profiles[id];

  // SAFETY: the gold file names a real rumour-kind profile; allProfiles has every combination.
  return allProfiles("rumour").find((p) => p.archetype === g.archetype && p.trusting === g.trusting && p.source === g.source) as Profile;
}

const [mode, dir] = process.argv.slice(2);

if (mode === "jobs") {
  const rows = lines.map((l, i) => ({ id: `gold-line-${i}`, request: teacherLineRequest({ kind: l.kind, text: l.text }) }));
  const profiles = PROFILE_IDS.map(profileFor);
  const rrows = rumours.map((r, i) => ({ id: `gold-rumour-${i}`, request: jevRequest(profiles, "rumour", r.text, null, r.place as never) }));

  writeFileSync(join(dir, "gold-lines.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  writeFileSync(join(dir, "gold-rumours.jsonl"), rrows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`wrote ${rows.length} line and ${rrows.length} rumour teacher jobs to ${dir}`);
  process.exit(0);
}

// ---------- scoring ----------

// Loaded here so writing the jobs works before any weights exist.
const { judgeLine } = await import("../../../live-worlds/free-model/runtime");
const { profileDists } = await import("../../../live-worlds/free-model/runtime-rumour");

const readLabels = (d: string | undefined, name: string) =>
  d && existsSync(join(d, name))
    ? new Map(
        readFileSync(join(d, name), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
          .map((r) => [r.id, r.answers as Record<string, Record<string, number>>]),
      )
    : new Map<string, Record<string, Record<string, number>>>();

/**
 * The teachers' own gold-set labels. The shipped teacher answers "honest" directly; the small
 * local one is scored the way its labels would have been used, honest read off its intent.
 */
const TEACHERS = [
  { id: "teacher", dir, honestFromIntent: false },
  { id: "qwen3-4b", dir: process.argv[4], honestFromIntent: true },
].map((t) => ({ ...t, lines: readLabels(t.dir, "labels-gold-lines.jsonl"), rumours: readLabels(t.dir, "labels-gold-rumours.jsonl") }));

type Extractor = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist: () => number[][] }>;

// SAFETY: transformers.js types the pipelines loosely; these are their call shapes.
const embed = (await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" })) as unknown as Extractor;
const nli = (await pipeline("zero-shot-classification", NLI_MODEL, { dtype: "q8" })) as unknown as ZeroShot;

const argmax = (d: Record<string, number>) => Object.entries(d).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
const yes = (a: Answer | undefined) => (typeof a?.value === "number" ? a.value : 0.5);

/** Accuracy and macro-F1 over the labels that occur in the gold set. */
function score(gold: string[], pred: string[]) {
  const labels = [...new Set(gold)];
  const f1s = labels.map((l) => {
    const tp = gold.filter((g, i) => g === l && pred[i] === l).length;
    const fp = pred.filter((p, i) => p === l && gold[i] !== l).length;
    const fn = gold.filter((g, i) => g === l && pred[i] !== l).length;

    return tp ? (2 * tp) / (2 * tp + fp + fn) : 0;
  });

  return {
    n: gold.length,
    accuracy: Math.round((1000 * gold.filter((g, i) => g === pred[i]).length) / gold.length) / 1000,
    macroF1: Math.round((1000 * f1s.reduce((a, b) => a + b, 0)) / labels.length) / 1000,
  };
}

type LinePred = { intent: string; honest: number; friendly: number };

const preds: Record<string, LinePred[]> = { student: [], mobilebert: [], ...Object.fromEntries(TEACHERS.map((t) => [t.id, []])) };
const timing: Record<string, number[]> = { student: [], mobilebert: [] };

// One text at a time, as the browser embeds it.
const vecs: number[][] = [];

for (const [i, l] of lines.entries()) {
  const e = { kind: l.kind, text: l.text };
  let t = performance.now();
  const [v] = (await embed([eventText(e)], { pooling: "mean", normalize: true })).tolist();
  const s = judgeLine(v, e);

  vecs.push(v);

  timing.student.push(performance.now() - t);
  // SAFETY: judgeLine returns a probability map for intent.
  preds.student.push({ intent: argmax(s.intent.probabilities as Record<string, number>), honest: yes(s.honest), friendly: yes(s.friendly) });

  t = performance.now();

  const m = await answerWithNli(nli, lineRequest(e));

  timing.mobilebert.push(performance.now() - t);
  // SAFETY: answerWithNli returns a probability map for choice questions.
  preds.mobilebert.push({ intent: argmax(m.intent.probabilities as Record<string, number>), honest: yes(m.honest), friendly: yes(m.friendly) });

  for (const t of TEACHERS) {
    const tl = t.lines.get(`gold-line-${i}`);

    if (tl)
      preds[t.id].push({
        intent: argmax(tl.intent),
        honest: t.honestFromIntent ? 1 - (tl.intent.lie ?? 0) - (tl.intent.bribe ?? 0) : tl.honest.true,
        friendly: tl.friendly.true,
      });
  }
}

const lineResults: Record<string, object> = {};

for (const [model, p] of Object.entries(preds)) {
  if (p.length !== lines.length) continue;

  const binary = (k: "honest" | "friendly") => {
    const idx = lines.map((l, i) => [l[k], i] as const).filter(([g]) => g !== null);

    return score(
      idx.map(([g]) => String(g)),
      idx.map(([, i]) => String(p[i][k] >= 0.5)),
    );
  };

  lineResults[model] = {
    intent: score(
      lines.map((l) => l.intent),
      p.map((x) => x.intent),
    ),
    honest: binary("honest"),
    friendly: binary("friendly"),
  };
}

// ---------- rumours ----------

const vectors: Vectors = { anchors: vectorsDoc.anchors, archetypes: vectorsDoc.archetypes, places: vectorsDoc.places };
const rvecs: number[][] = [];

for (const r of rumours) rvecs.push((await embed([r.text], { pooling: "mean", normalize: true })).tolist()[0]);

const rumourPreds: Record<string, { action: boolean[]; place: string[] }> = {
  student: { action: [], place: [] },
  formula: { action: [], place: [] },
  ...Object.fromEntries(TEACHERS.map((t) => [t.id, { action: [], place: [] }])),
};
const rumourMs: number[] = [];

for (const [i, r] of rumours.entries()) {
  const v = rvecs[i];
  const t = performance.now();
  // Both read the place with the keyword rule; a trained place head scored worse (see NOTES).
  const kwPlace = placeIn(r.text);
  const dists = profileDists(v, null, "rumour", kwPlace);

  rumourMs.push(performance.now() - t);

  const f = features(v, vectors);

  rumourPreds.student.place.push(kwPlace ?? "none");
  rumourPreds.formula.place.push(kwPlace ?? "none");

  for (const [j, id] of PROFILE_IDS.entries()) {
    const p = profileFor(id);
    const ok = (a: string) => r[id].includes(a);

    rumourPreds.student.action.push(ok(argmax(dists.get(p.key) ?? {})));
    rumourPreds.formula.action.push(ok(argmax(profileDist(f, p, "rumour", kwPlace))));

    for (const t of TEACHERS) {
      const tr = t.rumours.get(`gold-rumour-${i}`)?.[`p${j}`];

      if (tr) rumourPreds[t.id].action.push(ok(argmax(tr)));
    }
  }
}

const rumourResults: Record<string, object> = {};
const goldPlaces = rumours.map((r) => r.place ?? "none");

for (const [model, p] of Object.entries(rumourPreds)) {
  if (!p.action.length) continue;

  rumourResults[model] = {
    action: { n: p.action.length, accuracy: Math.round((1000 * p.action.filter(Boolean).length) / p.action.length) / 1000 },
    ...(p.place.length ? { place: score(goldPlaces, p.place) } : { place: "given the gold place" }),
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const results = {
  scoredOn: new Date().toISOString().slice(0, 10),
  winOver: { lines: lines.length, results: lineResults },
  rumourMill: { rumours: rumours.length, cases: rumours.length * PROFILE_IDS.length, results: rumourResults, note: "action accuracy = top action in the gold's accepted list" },
  nodeMs: {
    studentPerLine: Math.round(median(timing.student) * 10) / 10,
    mobilebertPerLine: Math.round(median(timing.mobilebert) * 10) / 10,
    studentPerRumourAllProfiles: Math.round(median(rumourMs) * 10) / 10,
  },
  intentLabels: INTENTS,
  rumourActions: RUMOUR_ACTIONS,
};

writeFileSync(new URL("../../../live-worlds/free-model/results.json", import.meta.url), JSON.stringify(results, null, 1) + "\n");

// The gold embeddings, so the student's gold scores can be re-checked without the encoder.
const b64 = (v: number[]) => Buffer.from(new Float32Array(v).buffer).toString("base64");

writeFileSync(
  new URL("../../../live-worlds/free-model/gold/embeddings.json", import.meta.url),
  JSON.stringify({ model: EMBED_MODEL, dtype: "q8", lines: vecs.map(b64), rumours: rvecs.map(b64) }) + "\n",
);
console.log(JSON.stringify(results, null, 1));
