/**
 * Bundles the extension's scripts into dist/ (the classifier and its weights go into
 * content.js). Run from anywhere:  bun jev-experiments/extensions/screen-sentry/build.ts
 */
const root = new URL(".", import.meta.url).pathname;

const r = await Bun.build({
  entrypoints: ["content", "background", "popup", "options"].map((n) => `${root}src/${n}.ts`),
  outdir: `${root}dist`,
  target: "browser",
  format: "iife",
  minify: true,
});

if (!r.success) {
  for (const m of r.logs) console.error(m);
  process.exit(1);
}

console.log(r.outputs.map((o) => `${o.path.split("/").pop()} ${(o.size / 1024).toFixed(1)} KB`).join("\n"));
