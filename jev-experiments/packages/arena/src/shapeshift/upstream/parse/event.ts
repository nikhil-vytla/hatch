import { capitalize, collapse, findDate, removeRange, tidy, titleCase } from "./common";

export type EventData = {
  title: string;
  date: Date | null;
  hasTime: boolean;
  people: string[];
  link: string | null;
  location: string | null;
};

const LINKS: Record<string, string> = {
  zoom: "Zoom",
  meet: "Google Meet",
  "google meet": "Google Meet",
  gmeet: "Google Meet",
  teams: "Teams",
  facetime: "FaceTime",
  skype: "Skype",
  discord: "Discord",
  whatsapp: "WhatsApp",
};

const STOP = /\s+(?:on|at|in|for|about|to|from|via|over)\s+.*$/i;

export function parseEvent(text: string, ref?: Date): EventData {
  let rest = ` ${collapse(text)} `;

  const date = findDate(rest, ref);
  if (date) rest = removeRange(rest, date.index, date.text.length);

  let link: string | null = null;
  const linkRe = /\s(?:on|over|via)\s+(google meet|gmeet|zoom|meet|teams|facetime|skype|discord|whatsapp)\b/i;
  const lm = rest.match(linkRe);
  if (lm && lm.index !== undefined) {
    link = LINKS[lm[1].toLowerCase()] ?? null;
    rest = removeRange(rest, lm.index, lm[0].length);
  }

  let location: string | null = null;
  const locRe = /\s(?:at|in)\s+(?!\d)([a-z][\w' ]{1,40}?)(?=\s+(?:with|on|for)\s|\s*$)/i;
  const loc = rest.match(locRe);
  if (loc && loc.index !== undefined) {
    location = titleCase(loc[1].trim());
    rest = removeRange(rest, loc.index, loc[0].length);
  }

  let people: string[] = [];
  const withRe = /\swith\s+(.+)$/i;
  const wm = rest.match(withRe);
  if (wm && wm.index !== undefined) {
    const segment = wm[1].replace(STOP, "");
    people = segment
      .split(/\s*(?:,|&|\band\b)\s*/i)
      .map((p) => p.trim())
      .filter((p) => p && p.split(" ").length <= 3 && !/^(the|my|a)$/i.test(p))
      .map((p) => titleCase(p));
    rest = rest.slice(0, wm.index) + " " + wm[1].slice(segment.length);
  }

  const title = capitalize(tidy(rest));
  return {
    title,
    date: date?.start ?? null,
    hasTime: date?.hasTime ?? false,
    people,
    link,
    location,
  };
}

export function completeEvent(d: EventData) {
  return (d.title ? 0.35 : 0) + (d.date ? 0.3 : 0) + (d.hasTime ? 0.2 : 0) + (d.people.length || d.link || d.location ? 0.15 : 0);
}
