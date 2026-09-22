import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encodeRecord } from "../experience-prototypes/scripts/records";
import { publicationSourceFromRecord, assertPublicationSource } from "./publication-source";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const policy = [{ subset: "Safety", id: "fixture", sha256: sha("authored display text") }];
const record = () => ({ manifest: { experiment: "rewardbench2", status: "complete" }, result: {
  rows: [{ subset: "Safety", id: "fixture", candidates: [{ text: "authored display text", label: "chosen", chosen: true, score: 8, probabilities: { "8": 1 } }] }],
  metrics: { score: 1 }, requests: [{ status: "completed", cost_usd: 0.01 }],
} });

test("source derivative retains exact lineage and all measurement fields without mutation", () => {
  const input = record(), source = encodeRecord(input);
  const derived = publicationSourceFromRecord(source, policy);
  expect(encodeRecord(input)).toBe(source);
  expect(derived.manifest.publication_source.source_sha256).toBe(sha(source));
  expect(derived.manifest.publication_source.kind).toBe("display-only-derivative");
  expect(derived.result.rows[0].candidates[0]).toMatchObject({ label: "chosen", chosen: true, score: 8, probabilities: { "8": 1 } });
  expect(derived.result.metrics).toEqual(input.result.metrics);
  expect(derived.result.requests).toEqual(input.result.requests);
  expect(publicationSourceFromRecord(encodeRecord(derived), policy)).toEqual(derived);
});

test("changed display input, ambiguous rows and incomplete full results fail closed", () => {
  const changed = record(); changed.result.rows[0].candidates[0].text = "changed";
  expect(() => publicationSourceFromRecord(encodeRecord(changed), policy)).toThrow();
  const duplicate = record(); duplicate.result.rows.push(structuredClone(duplicate.result.rows[0]));
  expect(() => publicationSourceFromRecord(encodeRecord(duplicate), policy)).toThrow("Duplicate");
  const missing = record(); missing.result.rows = [];
  expect(() => publicationSourceFromRecord(encodeRecord(missing), policy)).toThrow("missing");
});

test("partial checkpoints apply only their present pinned rows", () => {
  const partial = record(); partial.manifest.status = "partial"; partial.result.rows = [];
  const derived = publicationSourceFromRecord(encodeRecord(partial), policy);
  expect(derived.manifest.publication_source.withheld_candidate_texts).toBe(0);
  expect(derived.result.publication_projection.withheldCandidateTexts).toBe(0);
});

test("missing lineage, malformed lineage and restored display strings are rejected", () => {
  const derived = publicationSourceFromRecord(encodeRecord(record()), policy);
  const missing = structuredClone(derived); delete missing.manifest.publication_source;
  expect(() => publicationSourceFromRecord(encodeRecord(missing), policy)).toThrow("lineage");
  const malformed = structuredClone(derived); malformed.manifest.publication_source.source_sha256 = "invalid";
  expect(() => assertPublicationSource(malformed, policy)).toThrow("lineage");
  const restored = structuredClone(derived); restored.result.rows[0].candidates[0].text = "authored display text";
  expect(() => assertPublicationSource(restored, policy)).toThrow("display");
});
