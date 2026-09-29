import { createHash } from "node:crypto";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an evidence object.");
  return value as Record<string, unknown>;
};

export type WithheldCandidate = { subset: string; id: string; sha256: string };
export const withheldCandidates: readonly WithheldCandidate[] = [
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
export const withheldNotice = "[Candidate text withheld from this publication copy.]";

/** Clone the decoded display document. Derivative source lineage belongs in manifest.publication_source. */
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
    note: "Display-only text withholding. Recorded row counts, labels, model scores and aggregate metrics are unchanged. Source lineage is recorded separately from this projection and the benchmark's content-review omissions.",
  };
  return output;
}

/**
 * RewardBench's page shows one case at a time, but loading the whole document meant every
 * visitor downloaded all 1,865 cases' answer texts first. This splits the published document
 * into an index (everything except candidate texts, each row naming its case file) and one
 * small file of texts per case, named by content hash so a changed case gets a new name.
 */
export function splitRewardBench(input: unknown) {
  const document = structuredClone(object(input));
  const result = object(document.result);

  if (!Array.isArray(result.rows)) throw new Error("Missing benchmark rows.");

  const cases: { name: string; body: string }[] = [];

  result.rows = result.rows.map((value) => {
    const row = object(value);

    if (!Array.isArray(row.candidates)) return row;

    const texts = row.candidates.map((c) => String(object(c).text ?? ""));
    const body = JSON.stringify({ texts });
    const name = `${String(row.subset).replace(/[^A-Za-z0-9]+/g, "-")}-${String(row.id).replace(/[^A-Za-z0-9-]+/g, "-")}-${sha256(body).slice(0, 12)}.json`;

    cases.push({ name, body });

    return {
      ...row,
      case_file: name,
      candidates: row.candidates.map((c) => {
        const { text: _text, ...rest } = object(c);

        return rest;
      }),
    };
  });

  return { index: document, cases };
}
