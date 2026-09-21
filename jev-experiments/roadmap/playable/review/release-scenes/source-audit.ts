/** Read-only source/catalog inventory. No rendering, simulation or model calls. */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { experiments } from "../../../../experience-prototypes/src/catalog";

const lab = resolve(import.meta.dir, "../../../..");
const files = [
  "experience-prototypes/src/main.tsx", "experience-prototypes/src/catalog.ts",
  "experience-prototypes/src/live-tetris.tsx", "live-worlds/tetris/session.ts",
  "experience-prototypes/src/live-crowd.tsx", "live-worlds/crowd/engine.ts",
  "experience-prototypes/src/music-arranger.tsx", "music-arranger-v2/engine.ts",
  "roadmap/materials/MaterialsSandbox.tsx", "roadmap/materials/engine.ts",
  "roadmap/credits.tsx", "experience-prototypes/scripts/prepare.ts",
];
const source = Object.fromEntries(files.map(file => [file, readFileSync(resolve(lab, file), "utf8")]));
const materials = source["roadmap/materials/MaterialsSandbox.tsx"];
const panel = materials.slice(materials.indexOf('<details className="mat-evidence">'));
const report = {
  scope: "Read-only current source inventory; no browser/performance/GPU/model execution. Existence of a route or data file is not a complete usability test.",
  recordedAt: new Date().toISOString(),
  sourceHashes: Object.fromEntries(files.map(file => [file, createHash("sha256").update(source[file]).digest("hex")])),
  catalog: experiments.map(experiment => ({
    id: experiment.id,
    title: experiment.title,
    data: experiment.data,
    localSceneOrIndependentToolkit: ["materials", "routing"].includes(experiment.id),
    preparedDataExists: existsSync(resolve(lab, "experience-prototypes/public/data", experiment.data + ".json")),
  })),
  materialsEvidence: {
    frozenLabelClaim: panel.includes("Instruction labels were frozen"),
    evidencePanelHasLink: /<a\b/.test(panel),
    evidencePanelHasDownload: /<a\b[^>]*\bdownload=/.test(panel) || /\bdownload\s*\(/.test(panel),
    componentImportsProtocol: /from\s*["'][^"']*PROTOCOL\.md/.test(materials),
    componentImportsLabels: /from\s*["'][^"']*labels\.v1\.json/.test(materials),
    protocolPublishedByPrepare: source["experience-prototypes/scripts/prepare.ts"].includes("materials/PROTOCOL"),
    labelsPublishedByPrepare: source["experience-prototypes/scripts/prepare.ts"].includes("materials/labels"),
  },
  creditLinks: Array.from(source["roadmap/credits.tsx"].matchAll(/href="([^"]+)"/g), match => match[1]),
};
const output = resolve(import.meta.dir, process.argv[2] ?? "source-audit.json");
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, catalogEntries: report.catalog.length,
  missingPreparedData: report.catalog.filter(entry => !entry.preparedDataExists && !entry.localSceneOrIndependentToolkit).map(entry => entry.id),
  materialsEvidence: report.materialsEvidence }, null, 2));
