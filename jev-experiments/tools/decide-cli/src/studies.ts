/**
 * The studies `jev-lab eval` can run, built from the same job definitions the site's
 * recordings came from, so a new run is comparable request for request with ours.
 *
 * - fool: Fool Jev's 5 puzzles x 18 sentences (answer + referee requests), packages/arena/src/fool.
 * - suggestion: the prose studies' 20 true/false claims, canonical + the 5 suggestion variants.
 * - decoy: the prose studies' 8 decoy scenarios x 3 sets x 2 orders.
 *
 * Ids match the committed recordings (fool.jsonl, prose.jsonl.gz), so `compare` can line up a
 * fresh run against ours.
 */
import { answerRequest, PUZZLES, refereeRequest, sentencesFor } from "../../../packages/arena/src/fool/model";
import { allJobs, type Job as ProseJob } from "../../../packages/arena/prose/variants";

import type { Payload } from "../../../packages/jev-client/src/wire";

export type { Payload };

export type Job = { id: string; study: StudyId; request: Payload };

export const STUDIES = ["fool", "suggestion", "decoy"] as const;

export type StudyId = (typeof STUDIES)[number];

export const isStudy = (s: string): s is StudyId => (STUDIES as readonly string[]).includes(s);

/** The prose jobs behind a prose study, with their readers (analysis needs them). */
export function proseJobs(study: "suggestion" | "decoy"): ProseJob[] {
  return allJobs().filter((j) =>
    study === "decoy"
      ? j.study === "decoy"
      : j.study === "claim-truth" && (j.family === "suggestion" || (j.family === "baseline" && j.variant === "canonical")),
  );
}

export function jobsFor(study: StudyId): Job[] {
  if (study === "fool")
    return PUZZLES.flatMap((p) =>
      sentencesFor(p.id).flatMap((s): Job[] => [
        { id: `answer:${p.id}:${s}`, study, request: answerRequest(p, s) },
        ...(s ? [{ id: `referee:${p.id}:${s}`, study, request: refereeRequest(p, s) }] : []),
      ]),
    );

  return proseJobs(study).map((j) => ({ id: j.id, study, request: j.request as Payload }));
}

/** Which study a recorded row belongs to, from its id. */
export function studyOf(id: string): StudyId | null {
  if (id.startsWith("answer:") || id.startsWith("referee:")) return "fool";
  if (id.startsWith("decoy:")) return "decoy";
  if (/^claim-truth:[^:]+:(suggestion|baseline):/.test(id)) return "suggestion";

  return null;
}
