/**
 * Joins the labelling jobs with the open teacher's answers, embeds every text once, and writes
 * float32 training matrices (X, soft targets Y, masks, split) for train.py. Features come from
 * features.ts, the same code the browser runs.
 *
 *   cd jev-experiments/experience-prototypes && bun ../packages/arena/scripts/free-model-dataset.ts JOBS LABELS OUT [--honest-from-intent]
 */
import { pipeline } from "@huggingface/transformers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Profile } from "../../../live-worlds/rumour/profiles";
import { allProfiles } from "../../../live-worlds/rumour/profiles";
import type { Event } from "../../../live-worlds/win-over/decide";
import {
  ACTIONS_WO,
  EMBED_MODEL,
  eventText,
  INTENTS,
  LIKES,
  lineInput,
  profileInput,
  reactionInput,
  RUMOUR_ACTIONS,
} from "../../../live-worlds/free-model/features";

const [jobsDir, labelsDir, outDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const HONEST_FROM_INTENT = process.argv.includes("--honest-from-intent");

mkdirSync(outDir, { recursive: true });

type Extractor = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist: () => number[][] }>;

// SAFETY: transformers.js types the pipeline loosely; this is the feature-extraction call shape.
const extract = (await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" })) as unknown as Extractor;

const cache = new Map<string, number[]>();

/**
 * One text at a time, as the browser embeds it: q8 quantises activations per batch, so a text
 * embedded in a padded batch differs from the same text alone by up to 0.03.
 */
async function embedAll(texts: string[]) {
  for (const t of new Set(texts.filter((x) => !cache.has(x)))) cache.set(t, (await extract([t], { pooling: "mean", normalize: true })).tolist()[0]);
}

const read = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

function labelled(name: string) {
  const labels = new Map(read(join(labelsDir, `${name}.jsonl`)).map((r) => [r.id, r.answers]));

  return read(join(jobsDir, `${name}.jsonl`))
    .filter((j) => labels.has(j.id))
    .map((j) => ({ ...j, answers: labels.get(j.id) }));
}

/** Writes rows of equal-length float vectors as one float32 matrix. */
function save(name: string, rows: { x: number[]; y: number[]; m?: number[]; split: string }[], meta: object) {
  if (!rows.length) return;

  const cols = (k: "x" | "y" | "m") => rows[0][k]?.length ?? 0;
  const mat = (k: "x" | "y" | "m") => {
    const n = cols(k);
    const a = new Float32Array(rows.length * n);

    rows.forEach((r, i) => a.set(r[k] ?? [], i * n));

    return a;
  };

  for (const k of ["x", "y", "m"] as const) if (cols(k)) writeFileSync(join(outDir, `${name}.${k}.f32`), Buffer.from(mat(k).buffer));

  writeFileSync(
    join(outDir, `${name}.json`),
    JSON.stringify({ ...meta, rows: rows.length, x: cols("x"), y: cols("y"), m: cols("m"), split: rows.map((r) => (r.split === "val" ? 1 : 0)) }),
  );
  console.log(`${name}: ${rows.length} rows × ${cols("x")} inputs`);
}

const yes = (a: Record<string, number> | undefined) => a?.true ?? 0.5;

// ---------- Win over: the line model ----------

const lines = labelled("wo-lines");
const reactions = labelled("wo-reactions");
const likeTexts = Object.fromEntries(LIKES.map((l) => [l, `Something about ${l}.`]));

await embedAll([...lines.map((l) => eventText(l.event)), ...reactions.map((r) => eventText(r.event)), ...Object.values(likeTexts)]);

const likeVectors = Object.fromEntries(LIKES.map((l) => [l, cache.get(likeTexts[l]) ?? []]));
const lineTargets = new Map<string, number[]>();

save(
  "line",
  lines.map((l) => {
    // --honest-from-intent is for the small local teacher (Qwen3-4B), which rates nearly every line
    // honest when asked directly but does call boasts lies; the shipped teacher answers directly.
    const intent = l.answers.intent ?? {};
    const honest = HONEST_FROM_INTENT ? Math.max(0, 1 - (intent.lie ?? 0) - (intent.bribe ?? 0)) : yes(l.answers.honest);
    const y = [...INTENTS.map((i) => intent[i] ?? 0), honest, yes(l.answers.friendly)];

    lineTargets.set(eventText(l.event), y);

    return { x: lineInput(cache.get(eventText(l.event)) ?? [], l.event), y, split: l.split };
  }),
  { heads: { intent: { kind: "softmax", labels: INTENTS, from: 0 }, honest: { kind: "sigmoid", from: 7 }, friendly: { kind: "sigmoid", from: 8 } } },
);

// ---------- Win over: the reaction model ----------

save(
  "reaction",
  reactions.flatMap((r) => {
    const line = lineTargets.get(eventText(r.event as Event));

    if (!line) return [];

    return [
      {
        x: reactionInput(cache.get(eventText(r.event)) ?? [], r.event, line, r.resident, r.goal, likeVectors),
        y: [yes(r.answers.warmer), ...ACTIONS_WO.map((a) => r.answers.action?.[a] ?? 0)],
        split: r.split,
      },
    ];
  }),
  { heads: { warmer: { kind: "sigmoid", from: 0 }, action: { kind: "softmax", labels: ACTIONS_WO, from: 1 } } },
);

writeFileSync(join(outDir, "like-vectors.json"), JSON.stringify(likeVectors));

// ---------- Win over: gossip, a lookup table over its whole closed input space ----------

const gossip = new Map<string, { believes: number[]; passOn: number[] }>();

for (const g of labelled("wo-gossip")) {
  const k = `${g.temper}|${g.mood}|${g.says}`;
  const e = gossip.get(k) ?? { believes: [], passOn: [] };

  e.believes.push(yes(g.answers.believes));
  e.passOn.push(yes(g.answers.passOn));
  gossip.set(k, e);
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

writeFileSync(
  join(outDir, "gossip-table.json"),
  JSON.stringify(Object.fromEntries([...gossip].map(([k, v]) => [k, [Math.round(mean(v.believes) * 1000) / 1000, Math.round(mean(v.passOn) * 1000) / 1000]]))),
);
console.log(`gossip table: ${gossip.size} cells`);

// ---------- The rumour mill ----------

const rumours = [...labelled("rm-rumours"), ...labelled("rm-counters")];

await embedAll(rumours.flatMap((r) => [r.text, ...(r.rumour ? [r.rumour] : [])]));

const profilesByKey = new Map([...allProfiles("rumour"), ...allProfiles("counter")].map((p) => [p.key, p] as [string, Profile]));

save(
  "profile",
  rumours.flatMap((r) =>
    (r.profiles as string[]).flatMap((key, i) => {
      const a = r.answers[`p${i}`];
      const p = profilesByKey.get(key);

      if (!a || !p) return [];

      const hasPlace = r.kind === "rumour" && !!r.place;

      return [
        {
          x: profileInput(cache.get(r.text) ?? [], r.rumour ? (cache.get(r.rumour) ?? null) : null, r.kind, p, hasPlace),
          y: RUMOUR_ACTIONS.map((act) => a[act] ?? 0),
          // 1 = this action was offered.
          m: RUMOUR_ACTIONS.map((act) => (act === "go" ? (hasPlace ? 1 : 0) : 1)),
          split: r.split,
        },
      ];
    }),
  ),
  { heads: { action: { kind: "softmax", labels: RUMOUR_ACTIONS, from: 0 } } },
);
