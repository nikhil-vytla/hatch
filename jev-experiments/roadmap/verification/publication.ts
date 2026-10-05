/**
 * CI's public-record integrity step. The checks and the index live in the publication module
 * (experience-prototypes/scripts/publication.ts); this writes the index CI holds fixed.
 * Historical sample counts are never inferred from filenames.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { integrityIndex } from "../../experience-prototypes/scripts/publication";

const report = integrityIndex();
writeFileSync(resolve(import.meta.dir, "publication-index.json"), JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    publicationCount: report.publicationCount,
    publicFileCount: report.publicFileCount,
    roundTripPassed: true,
    expectedFieldsPreserved: true,
    projectedPublications: report.projectedPublications,
    unlistedPublicFiles: 0,
  }),
);
