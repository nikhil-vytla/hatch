import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readRecord, encodeRecord } from "../experience-prototypes/scripts/records";
import { pack, SUBSETS } from "./protocol";
import { completed, summarize } from "./metrics";
import { hashText } from "./publication";
import { assertPublicationSource } from "./publication-source";
import { withheldCandidates, withheldNotice } from "../experience-prototypes/scripts/benchmark-publication";
import omissions from "./content-audit/public-omissions.json";

const root = import.meta.dir;
const document = readRecord(resolve(root, "results.jsonl"));
const { manifest, result } = document;
const publicationSource = assertPublicationSource(document);
const predecessor = structuredClone(document);
delete predecessor.manifest.publication_source;
delete predecessor.result.publication_projection;
const source = JSON.parse(
  readFileSync(resolve(root, "../.cache/rewardbench2/dataset.json"), "utf8"),
).map(pack);
const byId = new Map(source.map((r: any) => [`${r.subset}:${r.id}`, r]));
const assert = (condition: unknown, message: string) => {
  if (!condition) throw Error(message);
};
assert(
  manifest.status === "complete" && result.rows.length === 1865,
  "Full run is not complete",
);
assert(
  new Set(result.rows.map((r: any) => `${r.subset}:${r.id}`)).size === 1865,
  "Case keys collide",
);
let omittedPrompts = 0,
  omittedCandidates = 0,
  publicationCandidates = 0,
  candidateCount = 0;
for (const [rowIndex, row] of result.rows.entries()) {
  const raw: any = byId.get(`${row.subset}:${row.id}`);
  assert(raw && raw.input_hash === row.input_hash, "Source input mismatch");
  assert(completed(row), "Incomplete case");
  if (row.prompt_omission) {
    omittedPrompts++;
    assert(
      hashText(raw.prompt) === row.prompt_omission.sha256 &&
        row.prompt === omissions.notice,
      "Prompt omission mismatch",
    );
  } else assert(raw.prompt === row.prompt, "Prompt changed");
  assert(
    raw.candidates.length === row.candidates.length,
    "Candidate count changed",
  );
  row.candidates.forEach((c: any, i: number) => {
    candidateCount++;
    const original = raw.candidates[i];
    assert(
      original.label === c.label &&
        original.chosen === c.chosen &&
        original.model === c.model,
      "Label, order, or attribution changed",
    );
    assert(c.score >= 1 && c.score <= 10, "Invalid score");
    assert(!(c.omission && c.publication_omission), "Conflicting omission policies");
    if (c.omission) {
      omittedCandidates++;
      assert(
        hashText(original.text) === c.omission.sha256 &&
          c.text === omissions.notice,
        "Candidate omission mismatch",
      );
    } else if (c.publication_omission) {
      publicationCandidates++;
      assert(
        withheldCandidates.some((entry) => entry.subset === row.subset && entry.id === String(row.id) && entry.sha256 === hashText(original.text)) &&
          c.publication_omission.sha256 === hashText(original.text) && c.text === withheldNotice,
        "Publication candidate omission mismatch",
      );
      predecessor.result.rows[rowIndex].candidates[i].text = original.text;
      delete predecessor.result.rows[rowIndex].candidates[i].publication_omission;
    } else assert(original.text === c.text, "Candidate text changed");
  });
}
assert(
  candidateCount === 8977 && omittedPrompts === 3 && omittedCandidates === 6 && publicationCandidates === 4,
  "Coverage mismatch",
);
assert(hashText(encodeRecord(predecessor)) === publicationSource.source_sha256, "Pre-derivation record hash mismatch");
const metrics = summarize(result.rows);
for (const s of SUBSETS)
  assert(
    metrics.subsets[s].score === result.metrics.subsets[s].score,
    `Metric mismatch: ${s}`,
  );
assert(metrics.macro_score === result.metrics.macro_score, "Overall mismatch");
const prohibitedHashes = new Set(
  [...withheldCandidates.map((entry) => entry.sha256), ...omissions.omissions.flatMap((o) =>
    [o.prompt_sha256, ...o.candidates.map((c) => c.sha256)].filter(Boolean),
  )],
);
function scan(value: any): void {
  if (typeof value === "string")
    assert(
      !prohibitedHashes.has(hashText(value)),
      "Omitted text leaked into another field",
    );
  else if (value && typeof value === "object")
    Object.values(value).forEach(scan);
}
scan(result);
const successful = result.requests.filter((r: any) => r.status === "completed");
const report = {
  checked_at: new Date().toISOString(),
  passed: true,
  cases: result.rows.length,
  candidates: candidateCount,
  omitted_prompts: omittedPrompts,
  omitted_candidates: omittedCandidates,
  publication_candidate_omissions: publicationCandidates,
  publication_source: publicationSource,
  predecessor_reconstructed_sha256: hashText(encodeRecord(predecessor)),
  completed_requests: successful.length,
  request_attempts: result.requests.reduce(
    (n: number, r: any) => n + r.attempts.length,
    0,
  ),
  reported_cost_usd: successful.every((r: any) => r.cost_usd != null)
    ? successful.reduce((n: number, r: any) => n + r.cost_usd, 0)
    : null,
  metrics,
};
writeFileSync(
  resolve(root, "validation.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      ...report,
      metrics: { ...metrics, ties: { ...metrics.ties, per_pair: undefined } },
    },
    null,
    2,
  ),
);
