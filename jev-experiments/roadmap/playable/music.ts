import { type Candidate, type Score, type ScoreEvent } from "../../music-arranger-v2/engine";
const melody = (events: ScoreEvent[], phrase: number) => events.filter(e => e.phrase === phrase && e.track === "melody" && e.midi !== null).sort((a, b) => a.beat - b.beat);
/** A mechanical boundary constraint, not a judgement of musical quality. */
export function continuity(score: Score, index: number, candidate: Candidate, maximum: number) {
  const current = melody(candidate.events, index), previous = melody(score.events, index - 1).at(-1), next = melody(score.events, index + 1)[0];
  const leaps = [previous && current[0] ? Math.abs(previous.midi! - current[0].midi!) : null, next && current.at(-1) ? Math.abs(current.at(-1)!.midi! - next.midi!) : null].filter((n): n is number => n !== null);
  return { eligible: leaps.every(n => n <= maximum), leaps, reason: leaps.length ? `Boundary leaps: ${leaps.join(" / ")} semitones; limit ${maximum}.` : "No adjacent melody note to constrain." };
}
export type BlindOption = { source: string; score: Score };
export type BlindTrial = { id: string; phrase: number; options: [BlindOption, BlindOption]; heard: (0 | 1)[]; preference: "A" | "B" | "tie" | null; revealed: boolean };
export function blindTrial(options: [BlindOption, BlindOption], phrase: number, random: number, id: string): BlindTrial {
  if (!(random >= 0 && random < 1)) throw new Error("Expected a random draw in [0, 1).");
  return { id, phrase, options: structuredClone(random < .5 ? options : [options[1], options[0]]), heard: [], preference: null, revealed: false };
}
export function vote(trial: BlindTrial, preference: "A" | "B" | "tie"): BlindTrial {
  if (!trial.heard.includes(0) || !trial.heard.includes(1) || trial.revealed) throw new Error("Listen to both versions before recording one preference.");
  return { ...trial, preference, revealed: true };
}
