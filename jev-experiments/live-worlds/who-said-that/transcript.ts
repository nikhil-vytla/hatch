/**
 * Who said that? as a written transcript: lines grouped by conversation, consecutive lines from
 * one speaker joined into a turn. Shared by the command line (and the Mac app behind it) and the
 * page's "Copy transcript".
 */
import type { Heard } from "./signals";

export const speakerName = (who: number) => `Speaker ${who + 1}`;

export const conversationName = (conv: number) => `Conversation ${String.fromCharCode(65 + conv)}`;

/** Display numbers in order of first appearance, so ids left unused by hindsight leave no gaps. */
export function renumber(ids: number[]): Map<number, number> {
  const out = new Map<number, number>();

  for (const id of ids) if (!out.has(id)) out.set(id, out.size);

  return out;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export type Turn = { who: number; start: number; text: string };

/** Turns per conversation, in order of each conversation's first line. */
export function turns(heard: Heard[], labels: { who: number; conv: number }[]): Map<number, Turn[]> {
  const out = new Map<number, Turn[]>();

  labels.forEach((l, i) => {
    const list = out.get(l.conv) ?? [];
    const last = list.at(-1);

    if (last && last.who === l.who) last.text += ` ${heard[i].text}`;
    else list.push({ who: l.who, start: heard[i].start, text: heard[i].text });

    out.set(l.conv, list);
  });

  return out;
}

export function markdown(heard: Heard[], labels: { who: number; conv: number }[]): string {
  const byConv = turns(heard, labels);
  const one = byConv.size === 1;
  const who = renumber(labels.map((l) => l.who));
  const conv = renumber(labels.map((l) => l.conv));

  return [...byConv.entries()]
    .map(([c, ts]) => `${one ? "" : `## ${conversationName(conv.get(c)!)}\n\n`}${ts.map((t) => `**${speakerName(who.get(t.who)!)}** (${mmss(t.start)}): ${t.text}`).join("\n\n")}`)
    .join("\n\n");
}
