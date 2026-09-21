/** Verify that downloadable evidence survives the production build byte for byte. */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const assets = resolve(
  root,
  "jev-experiments/experience-prototypes/dist/assets",
);
const digest = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const built = new Map<string, string[]>();
for (const name of readdirSync(assets)) {
  const path = resolve(assets, name);
  if (!statSync(path).isFile()) continue;
  const hash = digest(path);
  built.set(hash, [...(built.get(hash) ?? []), relative(root, path)]);
}
const sources = new Set<string>();
for (const name of [
  "jev-experiments/roadmap/materials/MaterialsSandbox.tsx",
  "jev-experiments/roadmap/routing/evidence-links.ts",
  "jev-experiments/roadmap/routing/ModelRoutingLab.tsx",
  "jev-experiments/roadmap/training/TypedDecisionStudy.tsx",
  "jev-experiments/experience-prototypes/src/live-tetris.tsx",
]) {
  const path = resolve(root, name);
  for (const match of readFileSync(path, "utf8").matchAll(
    /from\s+["']([^"']+)\?url&no-inline["']/g,
  )) {
    sources.add(resolve(dirname(path), match[1]));
  }
}
// Complete decision-level exports are emitted by the study page's Vite URL glob.
const training = resolve(root, "jev-experiments/roadmap/training");
for (const name of readdirSync(training)) {
  if (
    /^export-decisions-.+\.jsonl$/.test(name) ||
    /^(results-|export-|robustness-|frozen-baselines).*\.json$/.test(name) ||
    [
      "release-status.json",
      "metric-correction.json",
      "sources.json",
      "corpus-manifest.json",
      "PROVENANCE.md",
      "REVIEW-DISPOSITION.md",
      "default-selection.json",
    ].includes(name)
  )
    sources.add(resolve(training, name));
}
const files = [...sources].sort().map((path) => {
  const sha256 = digest(path);
  return {
    source: relative(root, path),
    bytes: statSync(path).size,
    sha256,
    builtAssets: built.get(sha256) ?? [],
    preserved: built.has(sha256),
  };
});
const report = {
  conditions:
    "Current production build; exact byte hashes of every explicit evidence URL import and complete decision-comparison file. This supplements actual browser download checks.",
  files,
  passed: files.length >= 26 && files.every((file) => file.preserved),
};
writeFileSync(
  resolve(import.meta.dir, "evidence-assets.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    files: files.length,
    passed: report.passed,
    missing: files.filter((file) => !file.preserved).map((file) => file.source),
  }),
);
if (!report.passed) process.exitCode = 1;
