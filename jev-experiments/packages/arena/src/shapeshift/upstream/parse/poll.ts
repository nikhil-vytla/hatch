import { capitalize, collapse } from "./common";

export type PollData = { title: string; options: string[] };

const QUESTION_START = /^(?:should|shall|what|which|where|when|who|do|does|would|want|let'?s|vote|poll)\b/i;
const CONTEXT = /\s+((?:for|on|at|this|next|tonight|tomorrow|today)\b.*)$/i;

export function parsePoll(text: string): PollData {
  let t = collapse(text).replace(/\?+$/, "");
  let stem: string | null = null;

  const colon = t.indexOf(":");
  if (colon > 0) {
    stem = t.slice(0, colon).trim();
    t = t.slice(colon + 1).trim();
  }

  let parts = t.split(/\s*(?:,|\bor\b|\bvs\.?\b|\/)\s*/i).filter(Boolean);
  if (parts.length < 2) return { title: stem ? `${capitalize(stem)}?` : "", options: [] };

  let context: string | null = null;
  const last = parts[parts.length - 1];
  const cm = last.match(CONTEXT);
  if (cm && cm.index !== undefined && cm.index > 0) {
    context = cm[1];
    parts[parts.length - 1] = last.slice(0, cm.index);
  }

  if (!stem && QUESTION_START.test(parts[0])) {
    const words = parts[0].split(" ");
    const take = Math.max(1, parts[1].split(" ").length);
    if (words.length > take) {
      stem = words.slice(0, words.length - take).join(" ");
      parts[0] = words.slice(words.length - take).join(" ");
    }
  }

  parts = parts.map((p) => p.trim()).filter(Boolean);
  const base = capitalize(stem ?? parts.join(" or "));
  parts = parts.map(capitalize);
  const title = `${base}${context ? ` ${context}` : ""}?`;
  return { title, options: parts };
}

export function completePoll(d: PollData) {
  return Math.min(1, d.options.length / 2) * 0.8 + (d.title ? 0.2 : 0);
}
