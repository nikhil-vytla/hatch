/**
 * The free model against Jev's recorded run, on the same town and seed: the comparison the page
 * draws as two curves and the headline strip states as numbers. Pure, so the page and the
 * build share one computation.
 */
import { counts, simulate } from "./engine";
import { PRESETS } from "./presets";
import { allProfiles, toDist, type Dist, type MessageKind } from "./profiles";
import { features, profileDist, type Vectors } from "./similarity";
import type { PlaceId, Town } from "./town";

export type RecordedRow = {
  kind: MessageKind;
  latencyMs: number;
  answers: Record<string, { probabilities?: Record<string, number> } | null>;
};

/** The free model's answer for every profile, from a message vector. */
export function freeAnswers(vector: number[], vectors: Vectors, kind: MessageKind, place: PlaceId | null) {
  const f = features(vector, vectors);

  return new Map(allProfiles(kind).map((p) => [p.key, profileDist(f, p, kind, place)]));
}

/** Jev's recorded answers for one message kind. */
export function recordedAnswers(rows: RecordedRow[], kind: MessageKind) {
  const m = new Map<string, Dist>();

  for (const row of rows.filter((r) => r.kind === kind))
    for (const [k, a] of Object.entries(row.answers)) {
      const d = toDist(a?.probabilities);

      if (d) m.set(k, d);
    }

  return m;
}

export const SCAM = PRESETS.find((p) => p.id === "scam");

/** The scam spread on both models: each one's world after 60 s (curve and counts). */
export function scamComparison(town: Town, vectors: Vectors, messageVectors: Record<string, number[]>, rows: RecordedRow[]) {
  if (!SCAM) return null;

  const run = (answers: Map<string, Dist>) => simulate(town, "rumour", SCAM.text, SCAM.place, SCAM.block, answers, 1, 60);
  const free = run(freeAnswers(messageVectors[SCAM.text], vectors, "rumour", SCAM.place));
  const jev = run(recordedAnswers(rows, "rumour"));

  return { free: { curve: free.curve, counts: counts(free) }, jev: { curve: jev.curve, counts: counts(jev) } };
}
