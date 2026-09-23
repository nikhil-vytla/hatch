// Builds the app into out/: the main process and preload script (CommonJS,
// as Electron loads them) with Bun, and the renderer with Vite.

import react from "@vitejs/plugin-react";
import { build as vite } from "vite";

const here = import.meta.dir;

for (const [entry, name] of [
  ["src/main/main.ts", "main.cjs"],
  ["src/preload/preload.ts", "preload.cjs"],
] as const) {
  const r = await Bun.build({
    entrypoints: [`${here}/${entry}`],
    target: "node",
    format: "cjs",
    external: ["electron"],
    naming: name,
    outdir: `${here}/out`,
  });

  if (!r.success) throw new AggregateError(r.logs, `building ${entry}`);
}

await vite({
  root: `${here}/src/renderer`,
  base: "./",
  plugins: [react()],
  logLevel: "warn",
  build: { outDir: `${here}/out/renderer`, emptyOutDir: true },
});
