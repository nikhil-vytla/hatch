/**
 * Contestant colours, one light and one dark value each. Every value keeps at
 * least 3:1 against both page surfaces of its theme (WCAG non-text contrast).
 * Hue carries identity: green Jev, blue Laya, rust Qwen, violet small models
 * and robustness conditions. Neutral grey is reserved for code players.
 */
export type Swatch = { light: string; dark: string };

export const SURFACES = {
  light: ["#f6f2e9", "#fbf8f1"],
  dark: ["#1b1a17", "#221f1b"],
} as const;

export const PALETTE = {
  jev: { light: "#1e6b47", dark: "#7bd3a1" },
  jevTeal: { light: "#0f6772", dark: "#6fc7d3" },
  jevOlive: { light: "#5f5e12", dark: "#cfcb6b" },
  jevMoss: { light: "#3c7a32", dark: "#a6d98f" },
  laya: { light: "#3552a0", dark: "#93a9e8" },
  layaIndigo: { light: "#5645a8", dark: "#b3a6f0" },
  layaSlate: { light: "#44627f", dark: "#a2bdd6" },
  qwen: { light: "#9c4519", dark: "#eda173" },
  qwenSand: { light: "#80531f", dark: "#dcb27f" },
  qwenPlum: { light: "#843c62", dark: "#e0a0c3" },
  small: { light: "#6e3f96", dark: "#c7a0e6" },
  code: { light: "#5b5b5b", dark: "#b8b8b8" },
  codeMid: { light: "#6f6f6f", dark: "#a0a0a0" },
  codeLight: { light: "#848484", dark: "#8c8c8c" },
  conditionA: { light: "#4a3a9c", dark: "#b9adf2" },
  conditionB: { light: "#6d4fb8", dark: "#9f8ce6" },
  conditionC: { light: "#8a3f8f", dark: "#dd9ee0" },
} satisfies Record<string, Swatch>;

const channel = (hex: string, i: number) => {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;

  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string) =>
  0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);

export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);

  return (x + 0.05) / (y + 0.05);
}
