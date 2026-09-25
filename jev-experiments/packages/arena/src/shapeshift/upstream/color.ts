/** Minimal sRGB ⇄ OKLCH conversion (Björn Ottosson's OKLab). */

export type Oklch = { l: number; c: number; h: number };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function srgbToLinear(c: number) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(c: number) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

export function rgbToHex(r: number, g: number, b: number) {
  return (
    "#" +
    [r, g, b]
      .map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0"))
      .join("")
  );
}

export function hexToOklch(hex: string): Oklch | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => srgbToLinear(v / 255));
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.sqrt(A * A + B * B);
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: number[]) => rgb.every((v) => v >= -0.0001 && v <= 1.0001);

/** Convert to hex, reducing chroma until the color fits in sRGB. */
export function oklchToHex(color: Oklch): string {
  let c = color.c;
  let lin = oklchToLinear({ ...color, c });
  for (let i = 0; i < 24 && !inGamut(lin); i++) {
    c *= 0.9;
    lin = oklchToLinear({ ...color, c });
  }
  const [r, g, b] = lin.map((v) => clamp01(linearToSrgb(clamp01(v))) * 255);
  return rgbToHex(r, g, b);
}

/** Five shades of the same hue, from light to dark, via OKLCH lightness steps. */
export function shades(hex: string): string[] {
  const base = hexToOklch(hex);
  if (!base) return [];
  return [0.93, 0.8, 0.66, 0.5, 0.36].map((l) =>
    oklchToHex({ l, c: base.c * (l > 0.85 ? 0.35 : l < 0.4 ? 0.8 : 1), h: base.h }),
  );
}

export function withLightness(hex: string, l: number): string {
  const base = hexToOklch(hex);
  if (!base) return hex;
  return oklchToHex({ ...base, l: clamp01(l) });
}

/** Readable ink for text over a swatch. */
export function contrastInk(hex: string) {
  const o = hexToOklch(hex);
  return o && o.l > 0.68 ? "#1a1a19" : "#ffffff";
}
