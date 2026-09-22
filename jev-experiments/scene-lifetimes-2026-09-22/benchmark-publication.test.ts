import { resolve } from "node:path";
import { readRecord } from "../experience-prototypes/scripts/records";
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { projectRewardBenchDocument, withheldCandidates, withheldNotice } from "../experience-prototypes/scripts/benchmark-publication";
import { assertPublicationSource } from "../rewardbench2/publication-source";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("benchmark publication projection", () => {
  const withheldText = "A synthetic candidate chosen for display withholding.";
  const manifest = [
    { subset: "Synthetic", id: "7", sha256: hash(withheldText) },
  ];
  const fixture = () => ({
    manifest: { benchmark: "synthetic" },
    result: {
      accuracy: 0.5,
      public_omissions: { candidate_texts_omitted: 0 },
      rows: [
        {
          subset: "Synthetic",
          id: 7,
          prompt: "Choose the better response.",
          candidates: [
            {
              text: "A retained response.",
              chosen: true,
              score: 0.8,
              probabilities: [0.2, 0.8],
            },
            {
              text: withheldText,
              chosen: false,
              score: 0.2,
              probabilities: [0.8, 0.2],
            },
          ],
        },
      ],
    },
  });

  test("hash selection survives option reordering and does not change source, labels, scores or existing omission counts", () => {
    const source = fixture();
    source.result.rows[0].candidates.reverse();
    const before = structuredClone(source);
    const projected: any = projectRewardBenchDocument(source, manifest);
    const candidate = projected.result.rows[0].candidates[0];
    expect(candidate.text).toBe(
      "[Candidate text withheld from this publication copy.]",
    );
    expect(candidate.publication_omission.sha256).toBe(manifest[0].sha256);
    expect({
      chosen: candidate.chosen,
      score: candidate.score,
      probabilities: candidate.probabilities,
    }).toEqual({ chosen: false, score: 0.2, probabilities: [0.8, 0.2] });
    expect(projected.result.rows[0].prompt).toBe(source.result.rows[0].prompt);
    expect(projected.result.accuracy).toBe(0.5);
    expect(projected.result.public_omissions).toEqual(
      source.result.public_omissions,
    );
    expect(projected.result.publication_projection.withheldCandidateTexts).toBe(
      1,
    );
    expect(source).toEqual(before);
    expect(projectRewardBenchDocument(projected, manifest)).toEqual(projected);
  });

  test("stale hashes, missing rows and duplicate matches fail closed", () => {
    const changed = fixture();
    changed.result.rows[0].candidates[1].text += " Changed.";
    expect(() => projectRewardBenchDocument(changed, manifest)).toThrow("hash");
    expect(() =>
      projectRewardBenchDocument(fixture(), [{ ...manifest[0], id: "8" }]),
    ).toThrow("row");
    const ambiguous = fixture();
    ambiguous.result.rows[0].candidates.push(
      structuredClone(ambiguous.result.rows[0].candidates[1]),
    );
    expect(() => projectRewardBenchDocument(ambiguous, manifest)).toThrow(
      "ambiguous",
    );
  });
});

test("the pinned source derivative projects idempotently and retains its lineage and measurements", () => {
  const source = readRecord(resolve(import.meta.dir, "../rewardbench2/results.jsonl"));
  const before = hash(JSON.stringify(source));
  const lineage = assertPublicationSource(source);
  expect(lineage.kind).toBe("display-only-derivative");
  expect(lineage.source_sha256).toBe("cd4a22470cfde05ed0aa958c190bbc52e83b4aa21107eb1446f244a68bb957c8");
  const projected = projectRewardBenchDocument(source);
  expect(hash(JSON.stringify(source))).toBe(before);
  expect(projected).toEqual(source);
  expect(projected.result.publication_projection.withheldCandidateTexts).toBe(4);
  const omissions: { subset: string; id: string; sha256: string }[] = [];
  for (const row of projected.result.rows) {
    for (const value of row.candidates) {
      if (!value.publication_omission) continue;
      expect(value.text).toBe(withheldNotice);
      omissions.push({ subset: row.subset, id: String(row.id), sha256: value.publication_omission.sha256 });
    }
  }
  expect(omissions).toEqual(withheldCandidates);
});
