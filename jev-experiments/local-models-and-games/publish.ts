import { readFileSync } from "node:fs";
import { writeRecord } from "../experience-prototypes/scripts/records";
const record = JSON.parse(
  readFileSync(
    new URL("../.cache/apple-decisions/publication.json", import.meta.url),
    "utf8",
  ),
);
if (
  record.result.cases.length !== 400 ||
  record.result.models.some((m: any) => m.metrics.decisions !== 2000)
)
  throw new Error("Incomplete model comparison");
if (!record.result.coreml.passed)
  throw new Error("Core ML verification did not pass");
writeRecord(new URL("./apple/results.jsonl", import.meta.url).pathname, record);
console.log(
  `Published ${record.result.models.length} models, ${record.result.cases.length} complete cases.`,
);
