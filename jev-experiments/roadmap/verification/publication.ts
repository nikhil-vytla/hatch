/** Build-derived inventory. Historical sample counts are never inferred from filenames. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { assertPreserved } from "./record-integrity";
import { assertPublicationSource } from "../../rewardbench2/publication-source";
import { projectRewardBenchDocument } from "../../experience-prototypes/scripts/benchmark-publication";
import {
  readRecord,
  encodeRecord,
  decodeRecord,
} from "../../experience-prototypes/scripts/records";
const app = resolve(import.meta.dir, "../../experience-prototypes");
const publication: Record<string, string> = JSON.parse(
  readFileSync(resolve(app, "publication.json"), "utf8"),
);
const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

const files = Object.entries(publication).map(([name, relative]) => {
  const source = resolve(app, relative),
    output = resolve(app, "public/data", `${name}.json`);
  if (!existsSync(source) || !existsSync(output))
    throw Error(`Missing source or prepared output: ${name}`);
  const original = readRecord(source),
    prepared = JSON.parse(readFileSync(output, "utf8"));
  if (
    JSON.stringify(decodeRecord(encodeRecord(original))) !==
    JSON.stringify(original)
  )
    throw Error(`JSONL round trip changed ${name}`);
  if (!prepared || typeof prepared !== "object")
    throw Error(`Invalid public JSON: ${name}`);
  // Compare the publication-source derivative in full. Its predecessor hash
  // is lineage metadata, not a claim that committed bytes are original data.
  const projected = name === "rewardbench2";
  const derivation = projected ? assertPublicationSource(original) : null;
  const expected = projected ? projectRewardBenchDocument(original) : original;
  assertPreserved(expected, prepared, name);
  return {
    name,
    source: relative,
    sourceSha256: sha(readFileSync(source)),
    publicSha256: sha(readFileSync(output)),
    publicBytes: readFileSync(output).length,
    comparison: projected ? "publication-source-derivative" : "original-record",
    ...(derivation ? { sourceDerivation: derivation } : {}),
    recipe:
      name === "judgment-reliability"
        ? "prepareJudgmentReliability"
        : projected
          ? "readRecord + enrichProvenance + projectRewardBenchDocument"
        : "readRecord + enrichProvenance + availability",
  };
});
const unlisted = readdirSync(resolve(app, "public/data")).filter(
  (f) => !f.endsWith(".json") || !Object.hasOwn(publication, f.slice(0, -5)),
);
if (unlisted.length) throw Error(`Unlisted output: ${unlisted.join(", ")}`);
const report = {
  schemaVersion: 3,
  publicationCount: files.length,
  roundTripPassed: true,
  expectedFieldsPreserved: true,
  projectedPublications: files.filter((file) => file.comparison === "publication-source-derivative").map((file) => file.name),
  unlistedPublicFiles: unlisted,
  files,
};
writeFileSync(
  resolve(import.meta.dir, "publication-index.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    publicationCount: files.length,
    roundTripPassed: true,
    expectedFieldsPreserved: true,
    projectedPublications: report.projectedPublications,
    unlistedPublicFiles: 0,
  }),
);
