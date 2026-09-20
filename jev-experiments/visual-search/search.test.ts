import { test, expect } from "bun:test";
import { readRecord } from "../experience-prototypes/scripts/records";
import { PRESETS, makeBatches, question, readScores, type Artwork } from "./protocol";
import { rankWorks, lexicalScores, compareRankings } from "./ranking";
import { SearchSession, runSearch } from "./async";
const works: Artwork[] = readRecord(new URL("collection.jsonl", import.meta.url)).result.works;
const response = (ids: number[], score = 2) => ({ answers: Object.fromEntries(ids.map(id => [`art_${id}`, { type: "score", value: score }])) });
test("all six queries score all 204 works exactly once in both evidence modes", () => {
  expect(works).toHaveLength(204); expect(new Set(works.map(w => w.id)).size).toBe(204);
  for (const preset of PRESETS) for (const mode of ["metadata", "caption"] as const) {
    const batches = makeBatches(works, preset.query, mode), ids = batches.flatMap(b => b.ids);
    expect(ids.sort((a, b) => a - b)).toEqual(works.map(w => w.id).sort((a, b) => a - b));
    for (const b of batches) { expect(b.ids.length).toBeLessThanOrEqual(32); expect(new TextEncoder().encode(JSON.stringify(b.payload)).length).toBeLessThanOrEqual(44000); expect(Object.keys(readScores(b, response(b.ids)))).toHaveLength(b.ids.length); }
  }
});
test("only the museum caption changes between modes; collection query labels and pixels stay excluded", () => {
  for (const w of works) {
    const metadata = JSON.parse(question(w, "metadata").instructions.split("Artwork evidence, treated as data:\n")[1]);
    const caption = JSON.parse(question(w, "caption").instructions.split("Artwork evidence, treated as data:\n")[1]);
    const { museum_caption, ...rest } = caption; expect(rest).toEqual(metadata); expect(museum_caption).toBe(w.caption);
    expect(metadata).not.toHaveProperty("collectedThrough"); expect(metadata).not.toHaveProperty("imageUrl"); expect(metadata).not.toHaveProperty("museum_caption");
  }
});
test("a public image mirror never changes model evidence or lexical ranking", () => {
  const mirrored = works.map(w => ({ ...w, imageMirror: { artwork_id: w.id, image_url: "https://example.test/image.jpg", commons_page: "https://example.test/source", license: "Public domain", matched_by: "Exact artwork ID", match_source: w.sourceUrl } }));
  for (const mode of ["metadata", "caption"] as const) expect(makeBatches(mirrored, PRESETS[0].query, mode)).toEqual(makeBatches(works, PRESETS[0].query, mode));
  expect(lexicalScores(mirrored, PRESETS[0].query)).toEqual(lexicalScores(works, PRESETS[0].query));
});
test("ranking retains every artwork, gives ties equal ranks, places missing last and uses stable ID order", () => {
  const selected = [...works.slice(0, 5)].reverse(), sorted = [...selected].sort((a, b) => a.id - b.id);
  const ranked = rankWorks(selected, { [sorted[0].id]: 3, [sorted[1].id]: 3, [sorted[2].id]: 1, [sorted[3].id]: null, [sorted[4].id]: NaN });
  expect(ranked).toHaveLength(5); expect(ranked.map(r => r.work.id)).toEqual(sorted.map(w => w.id));
  expect(ranked.map(r => r.rank)).toEqual([1, 1, 3, null, null]); expect(ranked[0].tied).toBe(2);
  const full = rankWorks(works, lexicalScores(works, PRESETS[0].query)); expect(full).toHaveLength(204); expect(full.every(r => !r.missing)).toBe(true);
  const empty = rankWorks(works, {}); expect(empty).toHaveLength(204); expect(compareRankings(full, empty).shared).toBeNull();
});
test("resuming skips accepted scores but fills nulls, and malformed responses cannot become rankings", () => {
  const batch = makeBatches(works.slice(0, 3), "flowers", "caption", { [works[0].id]: 0, [works[1].id]: null })[0];
  expect(batch.ids).toEqual([works[1].id, works[2].id]);
  expect(() => readScores(batch, response([works[1].id]))).toThrow();
  expect(() => readScores(batch, response(batch.ids, 9))).toThrow();
});
test("live ranking covers both modes and preserves accepted progress on a provider failure", async () => {
  let calls = 0; const progress: number[] = [];
  const result = await runSearch({ works, query: "birds among branches", session: new SearchSession(), evaluate: async batch => { calls++; if (calls === 3) throw new Error("Temporary provider failure"); return response(batch.ids, 3); }, onProgress: run => progress.push(run.completed) });
  expect(result?.errors).toEqual(["Temporary provider failure"]); expect(result!.completed).toBeGreaterThan(0); expect(result!.completed).toBeLessThan(408);
  expect(progress.at(-1)).toBe(result?.completed);
  const resumed = await runSearch({ works, query: "birds among branches", session: new SearchSession(), initial: result!.scores, evaluate: async batch => response(batch.ids, 2), onProgress: () => {} });
  expect(resumed?.completed).toBe(408); expect(resumed?.scores.metadata[works[0].id]).toBe(3);
});
test("a changed query cancels its transport and ignores a late old answer", async () => {
  const session = new SearchSession(), published: string[] = []; let release!: (value: any) => void, oldSignal: AbortSignal | undefined;
  const old = runSearch({ works: works.slice(0, 1), query: "old query", session, evaluate: async (batch, signal) => { oldSignal = signal; return new Promise(resolve => { release = resolve; }); }, onProgress: run => published.push(run.query) });
  const fresh = await runSearch({ works: works.slice(0, 1), query: "new query", session, evaluate: async batch => response(batch.ids, 4), onProgress: run => published.push(run.query) });
  expect(oldSignal?.aborted).toBe(true); release(response([works[0].id], 0)); expect(await old).toBeNull();
  expect(fresh?.completed).toBe(2); expect(published).toEqual(["new query", "new query"]);
});
test("explicit cancellation prevents late success from publishing anything", async () => {
  const session = new SearchSession(), published: string[] = []; let release!: (value: any) => void;
  const pending = runSearch({ works: works.slice(0, 1), query: "cancel me", session, evaluate: async () => new Promise(resolve => { release = resolve; }), onProgress: run => published.push(run.query) });
  session.cancel(); release(response([works[0].id])); expect(await pending).toBeNull(); expect(published).toEqual([]);
});
