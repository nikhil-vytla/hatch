// The journal entries a proposal's evidence cites, as the main process picks
// them for the Learned pane: each cited entry, and the other half of a cited
// effect, so a command shows with its result and a result with its command.
import type { Digest, Entry } from "@strive/protocol";

/** Cited entries, in journal order, with the output of each finished effect among them. */
export type Cited = {
  entries: Entry[];
  /** Outputs by digest, cut to `OUTPUT_LIMIT`; one missing wasn't in the content store. */
  outputs: Record<Digest, string>;
};

/** The most of one output the pane shows. The judge reads 2000 characters; a person gets a little more. */
export const OUTPUT_LIMIT = 4000;

/** The entries `seqs` names, and the other half of each effect among them, in journal order. */
export function pick(entries: Entry[], seqs: readonly number[]): Entry[] {
  const cited = new Set(seqs);
  const halves = new Map<number, number[]>();

  for (const e of entries)
    if (e.event.type === "effectStarted" || e.event.type === "effectFinished")
      halves.set(e.event.effect, [...(halves.get(e.event.effect) ?? []), e.seq]);

  return entries.filter((e) => {
    if (cited.has(e.seq)) return true;

    if (e.event.type !== "effectStarted" && e.event.type !== "effectFinished") return false;

    return (halves.get(e.event.effect) ?? []).some((seq) => cited.has(seq));
  });
}

/** The outputs the picked entries name: what each finished effect showed the agent. */
export function outputsOf(entries: Entry[]): Digest[] {
  return entries.flatMap((e) =>
    e.event.type === "effectFinished" && e.event.outcome.kind === "done" ? [e.event.outcome.output] : [],
  );
}

/** `text` within `max` characters, keeping its start and its end (a command's error is usually last). */
export function cut(text: string, max: number): string {
  const chars = [...text];

  if (chars.length <= max) return text;

  const head = Math.floor((max * 2) / 5);
  const tail = max - head;

  return `${chars.slice(0, head).join("")}\n[… ${chars.length - max} characters cut …]\n${chars.slice(-tail).join("")}`;
}
