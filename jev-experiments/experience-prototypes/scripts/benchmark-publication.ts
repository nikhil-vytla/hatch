import { createHash } from "node:crypto";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an evidence object.");
  return value as Record<string, unknown>;
};

export type WithheldCandidate = { subset: string; id: string; sha256: string };
const withheldCandidates: readonly WithheldCandidate[] = [
  {
    subset: "Safety",
    id: "828",
    sha256: "29bcb708a9b1768d133d90652695c657099849a3e03e0ed439a8e5255ac87519",
  },
  {
    subset: "Safety",
    id: "1151",
    sha256: "2eda19a0a1c80b232b6c5647ec6ed8edd79fad318745b5078e9404a891a9494b",
  },
  {
    subset: "Focus",
    id: "1604",
    sha256: "cc337b8916915eb56bcd3cdc47430f79efc0a1bd802fc9180579c82416f64991",
  },
  {
    subset: "Focus",
    id: "1734",
    sha256: "9b39c32ca0521de3e662ac5cbb75ccd244df3751f7584aee5ec3e7eb2c19be10",
  },
];
const withheldNotice = "[Candidate text withheld from this publication copy.]";

/** Clone the decoded public document. Labels, scores, counts and original JSONL are unchanged. */
export function projectRewardBenchDocument<T>(
  input: T,
  manifest: readonly WithheldCandidate[] = withheldCandidates,
): T {
  const output = structuredClone(input);
  const document = object(output);
  const result = object(document.result);
  if (!Array.isArray(result.rows)) throw new Error("Missing benchmark rows.");
  for (const entry of manifest) {
    const rows = result.rows
      .map(object)
      .filter(
        (row) => row.subset === entry.subset && String(row.id) === entry.id,
      );
    if (rows.length !== 1 || !Array.isArray(rows[0].candidates))
      throw new Error("Expected publication row is missing or ambiguous.");
    const candidates = rows[0].candidates
      .map(object)
      .filter(
        (candidate) =>
          typeof candidate.text === "string" &&
          (sha256(candidate.text) === entry.sha256 ||
            (candidate.text === withheldNotice &&
              candidate.publication_omission &&
              object(candidate.publication_omission).sha256 === entry.sha256)),
      );
    if (candidates.length !== 1)
      throw new Error(
        "Expected publication text hash is missing or ambiguous.",
      );
    candidates[0].text = withheldNotice;
    candidates[0].publication_omission = {
      sha256: entry.sha256,
      reason:
        "Text withheld by publication policy; recorded labels and scores retained.",
    };
  }
  result.publication_projection = {
    version: "jev-public-candidate-text-v1",
    withheldCandidateTexts: manifest.length,
    note: "Additional display-only text withholding. Original source records, row counts, labels, model scores and aggregate metrics are unchanged; this is separate from the benchmark's content-review omissions.",
  };
  return output;
}
