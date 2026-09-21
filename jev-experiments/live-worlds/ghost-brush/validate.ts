import { resolve } from "node:path";
import { ENGINE_VERSION, RECIPES, marks, sampleStroke } from "./engine";
import { PROTOCOL, requestFor } from "./model";
const base = import.meta.dir;
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const sources = ["engine.ts", "model.ts", "session.ts", "engine.test.ts", "session.test.ts", "../../experience-prototypes/src/ghost-brush.tsx", "../../experience-prototypes/src/ghost-brush.css"];
const hashes = await Promise.all(sources.map(async path => ({ path, sha256: sha256(await Bun.file(resolve(base, path)).text()) })));
const stroke = sampleStroke();
const geometry = RECIPES.map(r => {
  const samples: number[] = []; let result = marks(stroke, r.id);
  for (let i = 0; i < 50; i++) { const start = performance.now(); result = marks(stroke, r.id); samples.push(performance.now() - start); }
  samples.sort((a, b) => a - b);
  return { id: r.id, pathCount: result.length, markSha256: sha256(JSON.stringify(result)), medianGeometryMs: Number(samples[25].toFixed(3)), p95GeometryMs: Number(samples[47].toFixed(3)) };
});
const result = { generatedAt: new Date().toISOString(), engine: ENGINE_VERSION, protocol: PROTOCOL, originalCodeOnly: true, modelCallsDuringValidation: 0, bankSha256: sha256(JSON.stringify(RECIPES)), sampleRequestSha256: sha256(JSON.stringify(requestFor("A quiet fabric made of blue threads"))), sources: hashes, geometry, note: "Bun CPU path-construction timings on one 82-point sample, 50 repeats per recipe. This is not a browser frame-rate or aesthetic-quality benchmark. Browser/lifecycle checks are described in README." };
await Bun.write(resolve(base, "validation.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ recipes: geometry.length, totalPaths: geometry.reduce((n, r) => n + r.pathCount, 0), medianGeometryMs: geometry.map(r => [r.id, r.medianGeometryMs]), modelCalls: 0 }, null, 2));
