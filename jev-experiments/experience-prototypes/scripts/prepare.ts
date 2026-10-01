import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readRecord } from "./records";
import { projectRewardBenchDocument, splitRewardBench } from "./benchmark-publication";
import { enrichProvenance } from "./provenance";
import { prepareJudgmentReliability } from "../../judgment-reliability/prepare";
import { prepareLiveWorlds } from "../../live-worlds/prepare";
import { preparePublicHarnessEvidence } from "../../capability-atlas-2026-09-22/publication-projection";
import { prepareCapabilityAtlas } from "../../capability-atlas-2026-09-22/prepare-atlas";
import { buildArena } from "../../packages/arena/src/data/build";
import { buildDecide } from "../../packages/arena/src/decide/build";
import { buildDecoy } from "../../packages/arena/prose/decoy-build";
import { buildFool } from "../../packages/arena/src/fool/build";
const lab = resolve(".."),
  dest = resolve("public/data");
const publication: Record<string, string> = JSON.parse(
  readFileSync("publication.json", "utf8"),
);
mkdirSync(dest, { recursive: true });
preparePublicHarnessEvidence(lab, resolve("public/routing-evidence"));
prepareCapabilityAtlas(lab, resolve("public"));
const hasSources = existsSync("results") || existsSync(resolve(lab, "results"));
if (hasSources) {
  prepareLiveWorlds();
}
for (const name of readdirSync(dest)) {
  if (!name.endsWith(".json") || !Object.hasOwn(publication, name.slice(0, -5)))
    throw new Error(
      `Unlisted public result: ${name}. Remove it or review the publication manifest.`,
    );
}
for (const [name, source] of Object.entries(publication)) {
  const target = resolve(dest, `${name}.json`);
  if (hasSources) {
    if (!existsSync(source))
      throw new Error(`Missing recorded evidence: ${source}`);
    const document = readRecord(source);
    if (document.result) enrichProvenance(name, document.result, lab);
    if (
      [
        "routing",
        "verify",
        "search",
        "ui",
        "visuals",
        "music",
        "logos",
        "language",
      ].includes(name)
    ) {
      const result = document.result,
        rows = result.rows ?? result.scenes ?? [];
      result.availability = {
        planned: rows.length,
        completed: rows.filter((row: any) => !row.error).length,
        unavailable: rows.filter((row: any) => !!row.error).length,
      };
    }
    writeFileSync(target, JSON.stringify(name === "rewardbench2" ? projectRewardBenchDocument(document) : document) + "\n");
  } else if (!existsSync(target)) {
    throw new Error(
      `Missing prepared evidence: ${name}. Run bun run build before deployment.`,
    );
  } else if (name === "rewardbench2") {
    writeFileSync(target, JSON.stringify(projectRewardBenchDocument(JSON.parse(readFileSync(target, "utf8")))) + "\n");
  }
}
// The RewardBench page loads a light index and fetches one case's answer texts at a time.
{
  const split = splitRewardBench(JSON.parse(readFileSync(resolve(dest, "rewardbench2.json"), "utf8")));
  const dir = resolve("public/rewardbench2");

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, "cases"), { recursive: true });
  writeFileSync(resolve(dir, "index.json"), JSON.stringify(split.index) + "\n");
  for (const c of split.cases) writeFileSync(resolve(dir, "cases", c.name), c.body + "\n");
}
mkdirSync("public/research", { recursive: true });
const qualityReview = resolve(lab, "quality-and-simulation-review");
if (existsSync(resolve(qualityReview, "review.html"))) {
  mkdirSync("public/research/quality-review", { recursive: true });
  for (const name of ["review.html", "README.md", "FUTURE-EXPERIMENTS.md"])
    if (existsSync(resolve(qualityReview, name))) copyFileSync(resolve(qualityReview, name), resolve("public/research/quality-review", name));
}
if (existsSync(resolve(lab, "real-time-playground/show-me-realtime.html")))
  copyFileSync(resolve(lab, "real-time-playground/show-me-realtime.html"), resolve("public/research/show-me-realtime.html"));
if (hasSources) {
  const iconBuild = spawnSync("bun", [resolve(lab, "icon-studio/collection.ts"), resolve("public/icon-studio")], { stdio: "inherit" });
  if (iconBuild.status !== 0) throw new Error("Icon collection preparation failed.");
  if (existsSync(resolve(lab, "icon-studio/events.jsonl")))
    copyFileSync(resolve(lab, "icon-studio/events.jsonl"), resolve("public/icon-studio/evidence.jsonl"));
  const document = prepareJudgmentReliability(resolve("public/judgment-reliability"));
  writeFileSync(resolve(dest, "judgment-reliability.json"), JSON.stringify(document) + "\n");
  mkdirSync(resolve("public/outcome-framing"), { recursive: true });
  if (existsSync(resolve(lab, "outcome-framing/events.jsonl")))
    copyFileSync(resolve(lab, "outcome-framing/events.jsonl"), resolve("public/outcome-framing/events.jsonl"));
  mkdirSync(resolve("public/visual-search"), { recursive: true });
  copyFileSync(resolve(lab, "visual-search/collection.jsonl"), resolve("public/visual-search/collection.jsonl"));
  if (existsSync(resolve(lab, "visual-search/events.jsonl")))
    copyFileSync(resolve(lab, "visual-search/events.jsonl"), resolve("public/visual-search/evidence.jsonl"));
  mkdirSync(resolve("public/wardrobe"), { recursive: true });
  if (existsSync(resolve(lab, "wardrobe-lab/recording.json")))
    copyFileSync(resolve(lab, "wardrobe-lab/recording.json"), resolve("public/wardrobe/recording.json"));
  if (existsSync(resolve(lab, "wardrobe-lab/assets")))
    cpSync(resolve(lab, "wardrobe-lab/assets"), resolve("public/wardrobe"), { recursive: true });
  for (const name of ["spoken-recording.json", "spoken-pipeline.json"])
    if (existsSync(resolve(lab, "wardrobe-lab", name))) copyFileSync(resolve(lab, "wardrobe-lab", name), resolve("public/wardrobe", name));
}
for (const name of ["README.md", "SOURCES.md", "IDEA_GARDEN.md"])
  if (existsSync(resolve(lab, name)))
    copyFileSync(resolve(lab, name), resolve("public/research", name));
if (existsSync(resolve(lab, "web/public/vision-input.png")))
  copyFileSync(
    resolve(lab, "web/public/vision-input.png"),
    "public/vision-input.png",
  );
if (existsSync("README.md"))
  copyFileSync("README.md", "public/research/EXPERIENCE_PROTOTYPES.md");
if (existsSync("extension/README.md"))
  copyFileSync("extension/README.md", "public/research/COMPANION.md");
if (existsSync("extension/manifest.json"))
  spawnSync("zip", ["-q", "-r", resolve("public/companion.zip"), "."], {
    cwd: "extension",
  });
console.log("Prepared recorded evidence and companion.");

// The arena reads recordings and public/data, so it runs after publication.
await buildArena(resolve("public/arena"));
buildDecide(resolve("../packages/arena"), resolve("public/decide"));
buildDecoy(resolve("../packages/arena/prose"), resolve("public/decoy"));
buildFool(resolve("../packages/arena"), resolve("public/fool"));
// The reef's recorded Jev run, still gzipped: the page decompresses it in the browser.
mkdirSync(resolve("public/ocean"), { recursive: true });
copyFileSync(resolve("../live-worlds/ocean/recordings/jev-heatwave.jsonl.gz"), resolve("public/ocean/jev-heatwave.jsonl.gz"));
