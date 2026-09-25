import { type Currency, detectCurrency, findAmount } from "./common";

export type SplitData = { total: number | null; people: number | null; currency: Currency };

const WORD_NUM: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function parseSplit(text: string): SplitData {
  let rest = text;
  let people: number | null = null;

  const n = rest.match(/\b(?:between|among|amongst|with|by|for|into)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten)\b(?:\s*(?:people|persons|friends|of us|ways))?/i)
    ?? rest.match(/\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s*(?:ways|people|persons|friends|of us)\b/i);
  if (n) {
    people = WORD_NUM[n[1].toLowerCase()] ?? Number(n[1]);
    rest = rest.replace(n[0], " ");
  } else {
    // "split 900 between me, rahul and priya" → count names
    const names = rest.match(/\b(?:between|among|with)\s+(.+)$/i);
    if (names) {
      const parts = names[1].split(/\s*(?:,|&|\band\b)\s*/i).filter((p) => /[a-z]/i.test(p));
      if (parts.length >= 2) people = parts.length;
      else if (parts.length === 1 && !/\d/.test(parts[0])) people = 2;
      rest = rest.replace(names[0], " ");
    }
  }

  const amount = findAmount(rest);
  return { total: amount?.value ?? null, people: people && people > 0 ? people : null, currency: detectCurrency(text) };
}

export function completeSplit(d: SplitData) {
  return (d.total ? 0.55 : 0) + (d.people ? 0.45 : 0);
}
