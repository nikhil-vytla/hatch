// The canvas and HTML inspectors share the same theme-specific material colors.
export const MATERIAL_PALETTE = {
  light: [
    "#f4f4f5",
    "#987431",
    "#4b838d",
    "#64748b",
    "#996244",
    "#bc5125",
    "#608780",
    "#80609e",
  ],
  dark: [
    "#141417",
    "#c59a4a",
    "#79abb3",
    "#7c8799",
    "#ad7957",
    "#e47d4c",
    "#bbd5d0",
    "#a487bd",
  ],
} as const;

export const materialPaletteStyle = Object.fromEntries(
  Object.entries(MATERIAL_PALETTE).flatMap(([theme, colors]) =>
    colors.map((color, id) => [`--mat-${theme}-${id}`, color]),
  ),
);

export const materialFill = (id: number) => `var(--mat-color-${id})`;
