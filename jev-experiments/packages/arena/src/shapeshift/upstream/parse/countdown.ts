import { capitalize, collapse, findDate, removeRange, tidy } from "./common";

export type CountdownData = { title: string; date: Date | null; days: number | null };

/** Fixed-date holidays chrono doesn't know by name: [month (0-based), day]. */
const HOLIDAYS: Record<string, [number, number]> = {
  christmas: [11, 25],
  xmas: [11, 25],
  "christmas eve": [11, 24],
  "new year": [0, 1],
  "new years": [0, 1],
  "new year's": [0, 1],
  "new years eve": [11, 31],
  "new year's eve": [11, 31],
  halloween: [9, 31],
  "valentine's day": [1, 14],
  "valentines day": [1, 14],
  valentines: [1, 14],
  "independence day": [7, 15],
  "republic day": [0, 26],
};

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

export function daysBetween(from: Date, to: Date) {
  return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / 86_400_000);
}

export function parseCountdown(text: string, ref: Date = new Date()): CountdownData {
  let rest = ` ${collapse(text)} `;
  let date: Date | null = null;
  let title = "";

  const names = Object.keys(HOLIDAYS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    const re = new RegExp(`\\b${name.replace(/'/g, "'?")}\\b`, "i");
    const m = rest.match(re);
    if (!m) continue;
    const [month, day] = HOLIDAYS[name];
    date = new Date(ref.getFullYear(), month, day);
    if (daysBetween(ref, date) < 0) date = new Date(ref.getFullYear() + 1, month, day);
    title = name.replace(/\b\w/g, (c) => c.toUpperCase()).replace("'S", "'s");
    rest = rest.replace(m[0], " ");
    break;
  }

  if (!date) {
    const hit = findDate(rest, ref);
    if (hit) {
      date = hit.start;
      rest = removeRange(rest, hit.index, hit.text.length);
    }
  }

  if (!title) {
    title = capitalize(
      tidy(rest.replace(/\b(?:how many|days?|weeks?|until|till|til|to go|left|countdown|count down|before|is it|are there|the)\b/gi, " ").replace(/\?/g, " ")),
    );
  }

  return { title, date, days: date ? daysBetween(ref, date) : null };
}

export function completeCountdown(d: CountdownData) {
  return (d.date ? 0.7 : 0) + (d.title ? 0.3 : 0);
}
