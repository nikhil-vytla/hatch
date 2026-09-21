/** Build only this authored study. No installation or provider calls required. */
import { resolve } from "node:path";
const here = import.meta.dir;
const engine = await Bun.file(resolve(here, "../roadmap/materials/engine.ts")).text();
const hash = new Bun.CryptoHasher("sha256").update(engine).digest("hex");
const result = await Bun.build({
  entrypoints: [resolve(here, "editorial-study.ts")],
  naming: "study.js",
  outdir: here,
  target: "browser",
  minify: true,
  sourcemap: "none",
  define: { ENGINE_SHA: JSON.stringify(hash) },
});
if (!result.success) throw new AggregateError(result.logs, "Study build failed");
console.log(`Built study.js with materials engine ${hash}`);
