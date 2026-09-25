import { capitalize, collapse, tidy } from "./common";

export type LinkData = { url: string | null; domain: string | null; monogram: string; note: string };

const URL_RE = /\b((?:https?:\/\/|www\.)[^\s]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|dev|io|app|org|net|co|ai|in|so|xyz|me|design|sh|gg|tv)(?:\/[^\s]*)?)/i;

export function parseLink(text: string): LinkData {
  const m = text.match(URL_RE);
  if (!m) return { url: null, domain: null, monogram: "", note: capitalize(tidy(text)) };
  const raw = m[1].replace(/[.,)]+$/, "");
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let domain: string | null = null;
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    domain = raw.replace(/^https?:\/\//, "").split("/")[0];
  }
  const note = capitalize(tidy(collapse(text.replace(m[0], " "))));
  return { url, domain, monogram: (domain?.[0] ?? "").toUpperCase(), note };
}

export function completeLink(d: LinkData) {
  return (d.url ? 0.8 : 0) + (d.note ? 0.2 : 0);
}
