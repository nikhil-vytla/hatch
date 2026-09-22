import { MATERIALS, type Rule } from "./engine";
import type { CellWindow } from "./mechanism";

export const contactSides = [
  { index: 3, name: "left" },
  { index: 5, name: "right" },
  { index: 1, name: "above" },
  { index: 7, name: "below" },
] as const;

/** Evaluate the displayed frame, not the evolving state inside an engine step. */
export function readContact(window: CellWindow, rule: Rule) {
  const material = MATERIALS.find(
    (item) => item.name.toLowerCase() === rule.contact,
  );
  return {
    custom: window.cells[4] === 7,
    enabled: rule.contact !== "none",
    matchingSides: material
      ? contactSides.filter((side) => window.cells[side.index] === material.id)
      : [],
  };
}
