import { capitalize, collapse, tidy } from "./common";

export type GoalData = { title: string; current: number; target: number | null; unit: string | null };

const n = (s: string) => Number(s.replace(/,/g, ""));
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?)(k)?`;

export function parseGoal(text: string): GoalData {
  let rest = ` ${collapse(text)} `;
  let current = 0;
  let target: number | null = null;
  const val = (num: string, k?: string) => n(num) * (k ? 1000 : 1);

  // "4 of 12", "4/12", "4 out of 12"
  const of = rest.match(new RegExp(String.raw`\b${NUM}\s*(?:of|/|out of)\s*${NUM}\b`, "i"));
  if (of) {
    current = val(of[1], of[2]);
    target = val(of[3], of[4]);
    rest = rest.replace(of[0], " ");
  } else {
    // "... 4 done", "saved 12000", "32 so far"
    const done = rest.match(new RegExp(String.raw`(?:\b(?:saved|done|finished|completed|at)\s+${NUM}|\b${NUM}\s*(?:done|so far|completed|finished|in))\b`, "i"));
    if (done) {
      current = val(done[1] ?? done[3], done[2] ?? done[4]);
      rest = rest.replace(done[0], " ");
    }
    const t = rest.match(new RegExp(String.raw`\b${NUM}\b`, "i"));
    if (t) {
      target = val(t[1], t[2]);
      rest = rest.replace(t[0], " ");
    }
  }

  const unitMatch = rest.match(/^\s*(?:[a-z]+\s+)?(books?|km|kms|miles?|pages?|workouts?|runs?|steps?|kg|lbs?|hours?|articles?|courses?|₹|rs|\$|dollars|rupees)\b/i);
  const unit = unitMatch ? unitMatch[1].toLowerCase() : null;
  rest = rest.replace(/\b(?:goal|target|progress|this year|this month|so far|done|by (?:end of )?\w+|in (?:january|february|march|april|may|june|july|august|september|october|november|december))\b/gi, " ");
  rest = rest.replace(/[,;]+/g, " ");
  return { title: capitalize(tidy(rest)), current: Math.min(current, target ?? current), target, unit };
}

export function completeGoal(d: GoalData) {
  return (d.target ? 0.6 : 0) + (d.title ? 0.3 : 0) + (d.current ? 0.1 : 0);
}
