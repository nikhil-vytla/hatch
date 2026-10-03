/**
 * Who said that? Scoring against the corpus's own transcript.
 *
 * Every transcribed word (from AMI's human annotation) is attributed to the segment that covers
 * most of it; words no segment covers count as missed. With one microphone per table, a word is
 * only attributed to segments on its own table's microphone (on the other one it's bleed). Predicted speakers, conversations and
 * topics are matched one-to-one to the true ones by how many words they share (greedy, largest
 * overlap first), then a word is right if its segment's label maps to its true label.
 */
import type { Heard } from "./signals";

/** `channel`, on scenarios with one microphone per table: the microphone at the speaker's table. */
export type TruthWord = { text: string; start: number; end: number; speaker: string; conversation: string; topic: string; channel?: number };

export type Truth = { words: TruthWord[]; counts: { speakers: number; conversations: number; topics: number } };

/** For each truth word, the index of the segment covering most of it, or -1. */
export function attribute(words: TruthWord[], heard: Heard[]): number[] {
  return words.map((w) => {
    let best = -1;
    let most = 0;

    for (const [k, h] of heard.entries()) {
      if (w.channel !== undefined && h.channel !== undefined && h.channel !== w.channel) continue;

      const o = Math.min(w.end, h.end) - Math.max(w.start, h.start);
      // Zero-length words (AMI marks some) count if they fall inside a segment.
      const inside = w.end === w.start && w.start >= h.start && w.start <= h.end ? 0.001 : 0;

      if (Math.max(o, inside) > most) {
        most = Math.max(o, inside);
        best = k;
      }
    }

    return best;
  });
}

/** One-to-one matching of predicted to true labels by shared words, largest first. */
export function match(pred: number[], truth: string[]): Map<number, string> {
  const pairs = new Map<string, number>();

  pred.forEach((p, k) => {
    if (p < 0) return;

    const key = `${p}\u0000${truth[k]}`;

    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  });

  const out = new Map<number, string>();
  const used = new Set<string>();

  for (const [key] of [...pairs.entries()].sort((a, b) => b[1] - a[1])) {
    const [p, t] = key.split("\u0000");

    if (out.has(Number(p)) || used.has(t)) continue;

    out.set(Number(p), t);
    used.add(t);
  }

  return out;
}

/** Share of words whose predicted label maps to their true label (missed words count as wrong). */
export function accuracy(pred: number[], truth: string[]) {
  const m = match(pred, truth);
  const right = pred.filter((p, k) => p >= 0 && m.get(p) === truth[k]).length;

  return { right, total: truth.length, share: truth.length ? right / truth.length : 0 };
}

export type Labels = { who: number; conv: number; topic: number }[];

/** Word-level accuracy for speakers, conversations and topics, plus how many words were missed. */
export function score(truth: Truth, heard: Heard[], labels: Labels, until = Infinity) {
  const end = until === Infinity ? Infinity : (heard[until - 1]?.end ?? 0);
  const words = truth.words.filter((w) => w.start <= end);
  const seg = attribute(words, heard.slice(0, Math.min(until, heard.length)));
  const at = (f: (l: Labels[number]) => number) => seg.map((k) => (k >= 0 && labels[k] ? f(labels[k]) : -1));

  return {
    words: words.length,
    missed: seg.filter((k) => k < 0).length,
    speaker: accuracy(at((l) => l.who), words.map((w) => w.speaker)),
    conversation: accuracy(at((l) => l.conv), words.map((w) => w.conversation)),
    topic: accuracy(at((l) => l.topic), words.map((w) => `${w.conversation}/${w.topic}`)),
  };
}
