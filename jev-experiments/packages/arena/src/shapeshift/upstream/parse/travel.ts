import { collapse, findDate, removeRange, titleCase } from "./common";

export type TravelData = { destination: string | null; origin: string | null; start: Date | null; end: Date | null };

/**
 * "this weekend" = the coming Sat–Sun (or the current one).
 * "next weekend" = the one after that when we're already at/near a weekend,
 * otherwise the coming one (how people usually mean it mid-week).
 */
function weekend(ref: Date, next: boolean): [Date, Date] {
  const d = new Date(ref);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const sat = new Date(d);
  sat.setDate(d.getDate() + (day === 0 ? -1 : 6 - day));
  if (next && (day === 5 || day === 6 || day === 0)) sat.setDate(sat.getDate() + 7);
  const sun = new Date(sat);
  sun.setDate(sat.getDate() + 1);
  return [sat, sun];
}

const STOP_WORDS =
  /\s+(?:to|next|this|on|for|from|in|by|via|tomorrow|today|tonight|with|and|trip|flight|train|bus|weekend|week|month|work|business|vacation|holiday|leave|leaving|return(?:ing)?|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?|\d)\b.*$/i;

export function parseTravel(text: string, ref: Date = new Date()): TravelData {
  let rest = ` ${collapse(text)} `;
  let start: Date | null = null;
  let end: Date | null = null;

  const wk = rest.match(/\b(this|next)\s+weekend\b/i);
  if (wk) {
    [start, end] = weekend(ref, wk[1].toLowerCase() === "next");
    rest = rest.replace(wk[0], " ");
  } else {
    // "12-15 oct" → chrono handles ranges; normalise en dashes first.
    const date = findDate(rest.replace(/[–—]/g, "-"), ref);
    if (date) {
      start = date.start;
      end = date.end;
      rest = removeRange(rest, date.index, date.text.length);
    }
  }

  const grab = (re: RegExp) => {
    const m = rest.match(re);
    if (!m) return null;
    const place = ` ${m[1]}`.replace(STOP_WORDS, "").trim();
    return place ? titleCase(place) : null;
  };

  const destination = grab(/\b(?:to|for|visit(?:ing)?|in)\s+([a-z][a-z .'-]{1,40})/i);
  const origin = grab(/\bfrom\s+([a-z][a-z .'-]{1,40})/i);
  return { destination, origin, start, end };
}

export function completeTravel(d: TravelData) {
  return (d.destination ? 0.5 : 0) + (d.start ? 0.35 : 0) + (d.end ? 0.15 : 0);
}
