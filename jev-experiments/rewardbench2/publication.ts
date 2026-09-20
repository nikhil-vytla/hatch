import { createHash } from "node:crypto";
import omissions from "./content-audit/public-omissions.json";

export const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex");

/** Remove reviewed fields from every published artifact, including JSONL source. */
export function preparePublicResult(result: any, manifest = omissions) {
  const byId = new Map(
    result.rows.map((row: any) => [`${row.subset}:${row.id}`, row]),
  );
  for (const entry of manifest.omissions) {
    const row: any = byId.get(`${entry.subset}:${entry.id}`);
    if (!row) continue;
    if (entry.prompt_omitted) {
      if (
        row.prompt_omission?.sha256 !== entry.prompt_sha256 &&
        hashText(row.prompt) !== entry.prompt_sha256
      )
        throw Error(`Omission source mismatch: ${entry.subset}:${entry.id}`);
      row.prompt = manifest.notice;
      row.prompt_omission = {
        sha256: entry.prompt_sha256,
        reason: manifest.criterion,
      };
    }
    for (const field of entry.candidates) {
      const candidate = row.candidates.find(
        (c: any) =>
          c.omission?.sha256 === field.sha256 ||
          hashText(c.text) === field.sha256,
      );
      if (!candidate)
        throw Error(`Omission candidate missing: ${entry.subset}:${entry.id}`);
      candidate.text = manifest.notice;
      candidate.omission = { sha256: field.sha256, reason: manifest.criterion };
    }
  }
  result.public_omissions = {
    ...manifest.coverage,
    criterion: manifest.criterion,
    note: "Text omissions affect display only. All cases retain their original labels and model scores.",
  };
  return result;
}
