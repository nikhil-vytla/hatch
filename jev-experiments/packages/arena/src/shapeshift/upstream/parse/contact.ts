import { collapse, titleCase } from "./common";

export type ContactData = { name: string; phone: string | null; email: string | null; initials: string };

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const PHONE_RE = /(?:\+?\d{1,3}[\s-]?)?\(?\d{3,5}\)?[\s-]?\d{3,5}[\s-]?\d{0,5}/;

export function formatPhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return raw.trim();
}

export function parseContact(text: string): ContactData {
  let rest = collapse(text);
  const em = rest.match(EMAIL_RE);
  const email = em ? em[0].toLowerCase() : null;
  if (em) rest = rest.replace(em[0], " ");

  let phone: string | null = null;
  const pm = rest.match(PHONE_RE);
  if (pm && pm[0].replace(/\D/g, "").length >= 7) {
    phone = formatPhone(pm[0]);
    rest = rest.replace(pm[0], " ");
  }

  const name = titleCase(
    rest
      .replace(/\b(?:save|add|contact|number|phone|email|mail|is|his|her|their|new|:)\b/gi, " ")
      .replace(/[^a-z\s'.-]/gi, " ")
      .trim(),
  );
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  return { name, phone, email, initials };
}

export function completeContact(d: ContactData) {
  return (d.name ? 0.4 : 0) + (d.phone || d.email ? 0.4 : 0) + (d.phone && d.email ? 0.2 : 0);
}
