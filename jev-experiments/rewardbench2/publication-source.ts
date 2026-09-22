import { createHash } from "node:crypto";
import { decodeRecord } from "../experience-prototypes/scripts/records";
import {
  projectRewardBenchDocument,
  withheldCandidates,
  type WithheldCandidate,
} from "../experience-prototypes/scripts/benchmark-publication";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const sourceNote = "Display-only derivative of the identified pre-derivation Jev result record, which already includes separate content-review omissions. These bytes are not the original evaluation record or upstream dataset. Recorded labels, scores, requests and metrics are retained.";

function selectedPolicy(document: any, policy: readonly WithheldCandidate[]) {
  if (document?.manifest?.experiment !== "rewardbench2" || !Array.isArray(document?.result?.rows))
    throw Error("Expected a RewardBench2 result record.");
  if (!["partial", "complete"].includes(document.manifest.status))
    throw Error("Expected explicit result completion status.");
  const keys = document.result.rows.map((row: any) => `${row.subset}:${row.id}`);
  if (new Set(keys).size !== keys.length) throw Error("Duplicate result row identity.");
  const selected = policy.filter((entry) => keys.includes(`${entry.subset}:${entry.id}`));
  if (document.manifest.status === "complete" && selected.length !== policy.length)
    throw Error("A complete result is missing a pinned publication row.");
  return selected;
}

function metadata(sourceSha256: string, policy: readonly WithheldCandidate[], count: number) {
  return {
    format: "jev-publication-source-v1",
    kind: "display-only-derivative",
    transform: "jev-public-candidate-text-v1",
    policy_sha256: sha256(JSON.stringify(policy)),
    source_format: "jev-records-v1",
    source_sha256: sourceSha256,
    withheld_candidate_texts: count,
    note: sourceNote,
  };
}

/** Validate derivative shape and policy, not the unavailable predecessor's bytes. */
export function assertPublicationSource(document: any, policy: readonly WithheldCandidate[] = withheldCandidates) {
  const selected = selectedPolicy(document, policy);
  const marker = document.manifest.publication_source;
  if (!marker || !/^[0-9a-f]{64}$/.test(marker.source_sha256 ?? ""))
    throw Error("Missing or invalid publication-source lineage.");
  if (JSON.stringify(marker) !== JSON.stringify(metadata(marker.source_sha256, policy, selected.length)))
    throw Error("Publication-source metadata or policy changed.");
  const omissions = document.result.rows.flatMap((row: any) => row.candidates
    .filter((candidate: any) => candidate.publication_omission)
    .map((candidate: any) => ({ subset: row.subset, id: String(row.id), sha256: candidate.publication_omission.sha256 })));
  if (omissions.length !== selected.length || omissions.some((entry: WithheldCandidate) =>
    !selected.some((expected) => expected.subset === entry.subset && expected.id === entry.id && expected.sha256 === entry.sha256)))
    throw Error("Unexpected publication-source omission.");
  if (JSON.stringify(projectRewardBenchDocument(document, selected)) !== JSON.stringify(document))
    throw Error("Publication-source display fields or projection changed.");
  return marker;
}

/** Derive a publication source from exact serialized predecessor bytes; never mutate the predecessor. */
export function publicationSourceFromRecord(text: string, policy: readonly WithheldCandidate[] = withheldCandidates) {
  const document = decodeRecord(text);
  if (document.manifest?.publication_source) {
    assertPublicationSource(document, policy);
    return document;
  }
  const selected = selectedPolicy(document, policy);
  if (document.result.publication_projection || document.result.rows.some((row: any) =>
    row.candidates.some((candidate: any) => candidate.publication_omission)))
    throw Error("Already-projected input requires explicit predecessor lineage.");
  const output = projectRewardBenchDocument(document, selected);
  output.manifest.publication_source = metadata(sha256(text), policy, selected.length);
  assertPublicationSource(output, policy);
  return output;
}
