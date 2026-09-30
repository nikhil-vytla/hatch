/** Text helpers for the prose studies: noise, numbers as words, and state layouts. */
import { rng, shuffled } from "../src/checkable/items";
import type { Fact } from "./items";

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A stable 32-bit seed from a string (FNV-1a). */
export function seedOf(s: string) {
  let h = 0x811c9dc5;

  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }

  return h;
}

const NEIGHBOURS: Record<string, string> = {
  a: "qsz", b: "vgn", c: "xdv", d: "sfe", e: "wrd", f: "dgr", g: "fht", h: "gjy", i: "uok",
  j: "hku", k: "jli", l: "ko", m: "nj", n: "bm", o: "ipl", p: "o", q: "wa", r: "etf", s: "adw",
  t: "ryg", u: "yij", v: "cfb", w: "qes", x: "zsc", y: "tuh", z: "xa",
};

/**
 * Seeded keyboard noise: each letter is, with probability `rate`, swapped with the next
 * character, dropped, doubled, or replaced by a neighbouring key. Deterministic per seed.
 */
export function typos(text: string, rate: number, seed: number) {
  const random = rng(seed);
  const chars = [...text];
  const out: string[] = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const lower = ch.toLowerCase();

    if (!/[a-z]/.test(lower) || random() >= rate) {
      out.push(ch);
      continue;
    }

    const kind = Math.floor(random() * 4);

    if (kind === 0 && i + 1 < chars.length && /[a-z]/i.test(chars[i + 1]!)) {
      out.push(chars[i + 1]!, ch);
      i++;
    } else if (kind === 1) {
      // dropped
    } else if (kind === 2) {
      out.push(ch, ch);
    } else {
      const options = NEIGHBOURS[lower] ?? lower;
      const swap = options[Math.floor(random() * options.length)]!;

      out.push(ch === lower ? swap : swap.toUpperCase());
    }
  }

  return out.join("");
}

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
  "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Cardinal words for a non-negative integer below one billion. */
export function intWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e9) throw Error(`Unsupported number ${n}`);
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000)
    return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${intWords(n % 100)}` : ""}`;
  if (n < 1e6)
    return `${intWords(Math.floor(n / 1000))} thousand${n % 1000 ? ` ${intWords(n % 1000)}` : ""}`;

  return `${intWords(Math.floor(n / 1e6))} million${n % 1e6 ? ` ${intWords(n % 1e6)}` : ""}`;
}

const ORDINAL: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth",
  twelve: "twelfth",
};

export function ordinalWords(n: number) {
  const words = intWords(n);
  const parts = words.split(/([ -])/);
  const last = parts.pop()!;
  const ord = ORDINAL[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);

  return [...parts, ord].join("");
}

function yearWords(y: number) {
  if (y >= 2000 && y < 2010) return intWords(y);
  if (y >= 1100 && y < 2100) {
    const hi = Math.floor(y / 100);
    const lo = y % 100;

    return `${intWords(hi)} ${lo === 0 ? "hundred" : lo < 10 ? `oh ${intWords(lo)}` : intWords(lo)}`;
  }

  return intWords(y);
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December",
];

/**
 * Writes the numbers in a value as words: ISO dates, clock times, money, percentages and plain
 * numbers. Numbers inside codes (HB-44817, sunflower88, 55-0192) are left alone.
 */
export function numbersAsWords(text: string) {
  return text
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) =>
      `${MONTHS[Number(m) - 1]} ${ordinalWords(Number(d))}, ${yearWords(Number(y))}`,
    )
    .replace(/(?<![\w:-])(\d{1,2}):(\d{2})(?![\w:-])/g, (_, h, m) => {
      const mm = Number(m);

      return `${intWords(Number(h))} ${mm === 0 ? "hundred" : mm < 10 ? `oh ${intWords(mm)}` : intWords(mm)}`;
    })
    .replace(
      /(?<![\w.,-])([$£])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%)?(?![\w-]|[.,]\d)/g,
      (_, currency: string | undefined, whole: string, frac: string | undefined, pct) => {
        let words = intWords(Number(whole.replace(/,/g, "")));

        if (frac) words += ` point ${[...frac].map((d) => ONES[Number(d)]).join(" ")}`;
        if (pct) words += " percent";
        if (currency === "$") words += whole === "1" && !frac ? " dollar" : " dollars";
        if (currency === "£") words += whole === "1" && !frac ? " pound" : " pounds";

        return words;
      },
    );
}

export const snake = (label: string) =>
  label
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const layouts = {
  json: (facts: Fact[]) => Object.fromEntries(facts),
  table: (facts: Fact[]) =>
    ["| Field | Value |", "| --- | --- |", ...facts.map(([k, v]) => `| ${k} | ${v} |`)].join("\n"),
  bullets: (facts: Fact[]) => facts.map(([k, v]) => `- ${k}: ${v}`).join("\n"),
  env: (facts: Fact[]) => facts.map(([k, v]) => `${snake(k)}=${JSON.stringify(v)}`).join("\n"),
  csv: (facts: Fact[]) =>
    [facts.map(([k]) => csvCell(k)).join(","), facts.map(([, v]) => csvCell(v)).join(",")].join("\n"),
  array: (facts: Fact[]) => facts.map(([field, value]) => ({ field, value })),
  xml: (facts: Fact[]) =>
    [
      "<facts>",
      ...facts.map(([k, v]) => `  <fact name="${xmlEscape(k)}">${xmlEscape(v)}</fact>`),
      "</facts>",
    ].join("\n"),
  snakeJson: (facts: Fact[]) => Object.fromEntries(facts.map(([k, v]) => [snake(k), v])),
};

/** Facts in a seeded order that differs from the authored one. */
export function shuffleFacts(facts: Fact[], seed: number) {
  const order = shuffled(facts, rng(seed));

  return order.every((f, i) => f === facts[i]) ? [...facts].reverse() : order;
}

/** Facts with the distractors interleaved, the facts keeping their own order. */
export function interleave(facts: Fact[], distractors: Fact[]) {
  const out: Fact[] = [];
  const n = Math.max(facts.length, distractors.length);

  for (let i = 0; i < n; i++) {
    if (distractors[i]) out.push(distractors[i]!);
    if (facts[i]) out.push(facts[i]!);
  }

  return out;
}

/** About 420 words that have nothing to do with any item, for the long-context variant. */
export const LONG_BACKGROUND = [
  "This record was exported from the operations workspace as part of the quarterly archive.",
  "The workspace keeps notes from several teams, and most of them are unrelated to the case below.",
  "Over the summer the facilities group replaced the lighting on the third floor with warmer bulbs,",
  "moved the recycling bins closer to the kitchen, and started a rota for watering the plants in the",
  "reception area. The plants had been struggling because the heating vents were set too high, and a",
  "volunteer suggested grouping them near the north windows where the light is softer. Since then the",
  "fern by the lifts has recovered and the two rubber plants have put out new leaves. The group also",
  "surveyed staff about the coffee machine; most people wanted a second grinder rather than a new",
  "machine, so a grinder was ordered and should arrive before the end of the month. Separately, the",
  "library corner received a donation of about forty paperbacks, mostly detective novels and travel",
  "writing, and a shelf label system was introduced so that borrowed books come back to the right",
  "place. The social committee organised a picnic in the park on the last Friday of August. Around",
  "sixty people came, the weather held, and the committee thanks everyone who brought food. Photos",
  "are on the shared drive in the folder named for the event. Next quarter the committee plans a",
  "quiz night and a charity walk along the canal; sign-up sheets will go up in the kitchen. The IT",
  "desk reminds everyone that the old printers on the second floor will be removed in October and",
  "that scanned documents now go to personal folders by default. If you still use the shared scan",
  "folder, please move anything you need before it is cleared. Finally, the parking area will be",
  "resurfaced over two weekends, so please use the side entrance during that time. The notes above",
  "are informational only. Nothing in them changes any policy, price, schedule or rule, and they",
  "should not be taken into account when reading the case record that follows. The archive team",
  "adds these notes to every exported record so that the context of the export is preserved for",
  "auditors, who have asked for a complete picture of what the workspace contained at the time.",
  "Questions about the archive can be sent to the operations inbox, which is checked every weekday.",
].join(" ");
