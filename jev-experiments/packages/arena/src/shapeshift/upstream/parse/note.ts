import { capitalize, collapse } from "./common";

export type NoteData = { title: string; body: string };

export function parseNote(text: string): NoteData {
  const lines = text.split("\n");
  const first = collapse(lines[0] ?? "");
  const body = collapse(lines.slice(1).join(" "));
  if (body) return { title: capitalize(first), body };
  // Single line: first sentence as title, rest as body.
  const m = first.match(/^(.{8,80}?[.!?])\s+(.+)$/);
  if (m) return { title: capitalize(m[1]), body: m[2] };
  return { title: capitalize(first), body: "" };
}

export function completeNote(d: NoteData) {
  const words = (d.title + " " + d.body).trim().split(/\s+/).filter(Boolean).length;
  return Math.min(1, words / 10);
}
