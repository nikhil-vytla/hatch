/**
 * Writes vectors.json: all-MiniLM-L6-v2 embeddings of the reference sentences, the archetype and
 * place descriptions, and the preset messages. The page ships these so a preset starts spreading
 * before the model has downloaded; your own text is embedded in your browser by the same model.
 *
 *   cd jev-experiments/experience-prototypes && bun scripts/rumour-vectors.ts
 */
import { pipeline } from "@huggingface/transformers";
import { writeFileSync } from "node:fs";
import { PRESETS } from "../../live-worlds/rumour/presets";
import { ANCHORS, EMBED_MODEL } from "../../live-worlds/rumour/similarity";
import { ARCHETYPES, PLACES } from "../../live-worlds/rumour/town";

type Extractor = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist: () => number[][] }>;

// SAFETY: transformers.js types the pipeline loosely; this is the feature-extraction call shape.
const embed = (await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" })) as unknown as Extractor;

const round = (v: number[]) => v.map((x) => Math.round(x * 1e4) / 1e4);

async function vectors(texts: Record<string, string>) {
  const keys = Object.keys(texts);
  const out = (await embed(Object.values(texts), { pooling: "mean", normalize: true })).tolist();

  return Object.fromEntries(keys.map((k, i) => [k, round(out[i])]));
}

const doc = {
  model: EMBED_MODEL,
  dtype: "q8",
  anchors: await vectors(ANCHORS),
  archetypes: await vectors(Object.fromEntries(ARCHETYPES.map((a) => [a.id, a.description]))),
  places: await vectors(Object.fromEntries(PLACES.map((p) => [p.id, p.description]))),
  messages: await vectors(Object.fromEntries(PRESETS.flatMap((p) => [[p.text, p.text], [p.counter, p.counter]]))),
};

writeFileSync(new URL("../../live-worlds/rumour/vectors.json", import.meta.url), JSON.stringify(doc) + "\n");
console.log(`Wrote ${Object.keys(doc.messages).length} messages and ${Object.keys(doc.anchors).length} anchors.`);
