import {
  readRecord,
  writeRecord,
} from "../experience-prototypes/scripts/records";
import { interpretEdit } from "./engine";
const file = new URL("./wardrobe.jsonl", import.meta.url),
  data = readRecord(file);
for (const row of data.result.rows) {
  row.rawDecision = interpretEdit(row.before, row.response);
  row.decision = interpretEdit(row.before, row.response, row.text);
  const matches = (d: any) =>
    d.action === row.expected.action &&
    (d.action !== "apply" ||
      JSON.stringify(d.outfit) === JSON.stringify(row.expected.outfit));
  row.score = {
    rawExact: matches(row.rawDecision),
    exact: matches(row.decision),
    guardChanged:
      JSON.stringify(row.rawDecision.outfit) !==
      JSON.stringify(row.decision.outfit),
  };
}
data.result.metrics = {
  rawExact: data.result.rows.filter((r: any) => r.score.rawExact).length,
  exact: data.result.rows.filter((r: any) => r.score.exact).length,
  total: data.result.rows.length,
  guardChanged: data.result.rows.filter((r: any) => r.score.guardChanged)
    .length,
  guardRejected: data.result.rows.filter(
    (r: any) => r.decision.action === "rejected",
  ).length,
};
data.manifest.guardRevision = "focused-pronoun-scope-v1";
data.manifest.guardDevelopedOnThisFixture = true;
data.result.coverage.limitation =
  data.result.coverage.limitation.split(" The focus guard")[0] +
  " The focus guard was developed after observing this fixture; guarded accuracy is not held-out model performance.";
writeRecord(file.pathname, data);
console.log(JSON.stringify(data.result.metrics));
