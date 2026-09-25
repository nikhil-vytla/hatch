import type { ColorMood } from "../jev/types";
import { hexToOklch, oklchToHex, rgbToHex } from "../color";

export type ColorData = {
  hex: string | null;
  name: string | null;
  source: "hex" | "rgb" | "named" | "mood" | null;
};

export const NAMED_COLORS: Record<string, string> = {
  red: "#e03131",
  crimson: "#c2255c",
  scarlet: "#f03e3e",
  maroon: "#862e2e",
  burgundy: "#7a1f3d",
  pink: "#f06595",
  rose: "#e64980",
  coral: "#ff7f6b",
  salmon: "#fa8072",
  peach: "#ffb38a",
  orange: "#ff7a1a",
  tangerine: "#ff8c2b",
  amber: "#f59f00",
  gold: "#e8b000",
  yellow: "#fcc419",
  mustard: "#d4a017",
  lemon: "#fff06a",
  cream: "#f7f0dc",
  beige: "#e8dcc4",
  sand: "#d8c49c",
  tan: "#c9a77c",
  brown: "#8b5a2b",
  chocolate: "#5d3a1a",
  olive: "#808a2f",
  lime: "#82c91e",
  green: "#2f9e44",
  sage: "#9caf88",
  mint: "#96f2d7",
  emerald: "#0ca678",
  forest: "#2b5c34",
  teal: "#0c8599",
  turquoise: "#22b8cf",
  cyan: "#15aabf",
  sky: "#74c0fc",
  blue: "#1c7ed6",
  navy: "#1b2a5c",
  cobalt: "#2451b7",
  indigo: "#4c6ef5",
  violet: "#7950f2",
  purple: "#7048e8",
  lavender: "#b197fc",
  lilac: "#c8a2c8",
  magenta: "#d6336c",
  plum: "#8e4585",
  grey: "#868e96",
  gray: "#868e96",
  slate: "#5c6b7a",
  charcoal: "#343a40",
  black: "#141414",
  white: "#fafaf9",
  ivory: "#fffff0",
};

/**
 * Specific references with a known color: pop culture, brands, gems and compound names.
 * Unambiguous enough that the offline classifier treats them as a strong color signal.
 */
export const REFERENCE_COLORS: Record<string, string> = {
  "minecraft diamond": "#4aedd9",
  "minecraft grass": "#7cbd6b",
  "minecraft emerald": "#17dd62",
  "minecraft gold": "#fcee4b",
  "minecraft redstone": "#ff0000",
  "tiffany blue": "#0abab5",
  tiffany: "#0abab5",
  "barbie pink": "#e0218a",
  barbie: "#e0218a",
  "spotify green": "#1db954",
  "coca cola red": "#f40009",
  "coke red": "#f40009",
  "netflix red": "#e50914",
  "facebook blue": "#1877f2",
  "twitter blue": "#1da1f2",
  "instagram pink": "#e1306c",
  "discord blurple": "#5865f2",
  blurple: "#5865f2",
  "starbucks green": "#00704a",
  "ferrari red": "#ff2800",
  "ikea blue": "#0058a3",
  "ikea yellow": "#ffda1a",
  "mcdonalds yellow": "#ffc72c",
  "hermes orange": "#f37021",
  "klein blue": "#002fa7",
  "millennial pink": "#f3cfc6",
  "matrix green": "#00ff41",
  "shrek green": "#b5c91f",
  "minion yellow": "#fce029",
  "pikachu yellow": "#f6d02f",
  pikachu: "#f6d02f",
  "hulk green": "#5ba331",
  "smurf blue": "#3d8ed9",
  "barney purple": "#7a3fa0",
  diamond: "#b9f2ff",
  ruby: "#e0115f",
  sapphire: "#0f52ba",
  amethyst: "#9966cc",
  jade: "#00a86b",
  topaz: "#ffc87c",
  pearl: "#eae0c8",
  onyx: "#353839",
  "sky blue": "#87ceeb",
  "baby blue": "#89cff0",
  "baby pink": "#f4c2c2",
  "hot pink": "#ff69b4",
  "neon green": "#39ff14",
  "electric blue": "#7df9ff",
  "midnight blue": "#191970",
  "forest green": "#228b22",
  "blood red": "#8a0303",
  "brick red": "#b22222",
  "royal blue": "#4169e1",
  "powder blue": "#b0e0e6",
  "army green": "#4b5320",
  "hunter green": "#355e3b",
  "burnt orange": "#cc5500",
  "rose gold": "#b76e79",
  "dusty rose": "#c4a4a7",
  "off white": "#f5f5f0",
  "off-white": "#f5f5f0",
  terracotta: "#e2725b",
  denim: "#1560bd",
  champagne: "#f7e7ce",
  copper: "#b87333",
  bronze: "#cd7f32",
  silver: "#c0c0c0",
  blush: "#de5d83",
};

/** Everyday words that name a color only in context ("coffee" is usually a drink). Parser-only. */
export const EVOCATIVE_COLORS: Record<string, string> = {
  ocean: "#1f6f8b",
  sea: "#2e8bc0",
  grass: "#5fa641",
  lava: "#cf1020",
  sunset: "#fd5e53",
  sunflower: "#ffc512",
  cherry: "#d2042d",
  wine: "#722f37",
  coffee: "#6f4e37",
  mocha: "#967969",
  latte: "#c5a582",
  rust: "#b7410e",
  eggplant: "#614051",
  avocado: "#568203",
  pistachio: "#93c572",
  flamingo: "#fc8eac",
  bubblegum: "#ffc1cc",
  snow: "#fffafa",
  fire: "#e25822",
  blood: "#8a0303",
  sky: "#87ceeb",
};

const escape = (k: string) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[ -]/g, "[\\s-]?");
const phraseRe = (table: Record<string, string>) =>
  new RegExp(`\\b(${Object.keys(table).sort((a, b) => b.length - a.length).map(escape).join("|")})\\b`, "gi");
export const REFERENCE_RE = phraseRe(REFERENCE_COLORS);
const EVOCATIVE_RE = phraseRe(EVOCATIVE_COLORS);

const normalizeKey = (m: string) => m.toLowerCase().replace(/[\s-]+/g, " ");

/** The last matching phrase wins ("a sunset like a ruby" → ruby). */
function lastPhrase(text: string, re: RegExp, table: Record<string, string>) {
  let found: string | null = null;
  for (const m of text.matchAll(re)) {
    const key = normalizeKey(m[1]);
    const hit = key in table ? key : key.replace(/ /g, "-") in table ? key.replace(/ /g, "-") : null;
    if (hit) found = hit;
  }
  return found;
}

const MOOD_BASE: Record<ColorMood, string> = {
  warm: "#f76707",
  cool: "#3b5bdb",
  neutral: "#b8b2a7",
  vivid: "#f2206c",
  pastel: "#a5d8ff",
  dark: "#1f2a44",
};

function modifiers(text: string, hex: string) {
  const o = hexToOklch(hex);
  if (!o) return hex;
  if (/\b(light|pale|soft|pastel|baby)\b/i.test(text)) return oklchToHex({ l: Math.max(o.l, 0.86), c: o.c * 0.55, h: o.h });
  if (/\b(dark|deep|midnight)\b/i.test(text)) return oklchToHex({ l: Math.min(o.l, 0.38), c: o.c * 0.85, h: o.h });
  if (/\b(bright|neon|vivid|electric)\b/i.test(text)) return oklchToHex({ l: o.l, c: o.c * 1.25, h: o.h });
  if (/\b(muted|dusty|faded)\b/i.test(text)) return oklchToHex({ l: o.l, c: o.c * 0.5, h: o.h });
  return hex;
}

export function parseColor(text: string, mood?: ColorMood | null): ColorData {
  const hex = text.match(/#([0-9a-f]{6}|[0-9a-f]{3})\b/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
    return { hex: `#${h.toLowerCase()}`, name: null, source: "hex" };
  }
  const rgb = text.match(/rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/i);
  if (rgb) {
    return { hex: rgbToHex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3])), name: null, source: "rgb" };
  }
  // Specific references beat plain names: "minecraft diamond", "tiffany blue".
  const ref = lastPhrase(text, REFERENCE_RE, REFERENCE_COLORS);
  if (ref) return { hex: REFERENCE_COLORS[ref], name: ref, source: "named" };

  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  // Prefer the last color word ("a warm sunset orange" → orange).
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i];
    const key = w in NAMED_COLORS ? w : w.endsWith("ish") && w.slice(0, -3) in NAMED_COLORS ? w.slice(0, -3) : null;
    if (key) {
      return { hex: modifiers(text, NAMED_COLORS[key]), name: key, source: "named" };
    }
  }
  const evocative = lastPhrase(text, EVOCATIVE_RE, EVOCATIVE_COLORS);
  if (evocative) return { hex: modifiers(text, EVOCATIVE_COLORS[evocative]), name: evocative, source: "named" };
  if (mood) return { hex: modifiers(text, MOOD_BASE[mood]), name: null, source: "mood" };
  return { hex: null, name: null, source: null };
}

export function completeColor(d: ColorData) {
  return d.source === "hex" || d.source === "rgb" ? 1 : d.source === "named" ? 0.8 : d.source === "mood" ? 0.5 : 0;
}
