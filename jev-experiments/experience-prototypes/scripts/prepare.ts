import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readRecord } from "./records";
import { enrichProvenance } from "./provenance";
const lab = resolve(".."),
  dest = resolve("public/data");
const publication: Record<string, string> = JSON.parse(
  readFileSync("publication.json", "utf8"),
);
mkdirSync(dest, { recursive: true });
const hasSources = existsSync("results") || existsSync(resolve(lab, "results"));
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
    writeFileSync(target, JSON.stringify(document) + "\n");
  } else if (!existsSync(target)) {
    throw new Error(
      `Missing prepared evidence: ${name}. Run bun run build before deployment.`,
    );
  }
}
mkdirSync("public/research", { recursive: true });
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
