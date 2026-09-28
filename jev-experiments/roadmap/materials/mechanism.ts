import {
  MATERIALS,
  paint,
  type Material,
  type Scene,
  type ruleRequest,
} from "./engine";
import type { SourceMarkers } from "../../experience-prototypes/src/components/source-code/source";

export type CellWindow = {
  x: number;
  y: number;
  tick: number;
  cells: (Material | null)[];
};
export type StepTrace = { before: CellWindow; after: CellWindow };
export type RuleAttempt = {
  status:
    "pending" | "proposed" | "applied" | "discarded" | "superseded" | "failed";
  revision: number;
  request: ReturnType<typeof ruleRequest>;
  response?: unknown;
  error?: string;
  appliedAt?: number;
};
export function inspectWindow(
  scene: Scene,
  point: { x: number; y: number },
): CellWindow {
  const cells: (Material | null)[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = point.x + dx,
        y = point.y + dy;
      cells.push(
        x < 0 || y < 0 || x >= scene.width || y >= scene.height
          ? null
          : (scene.cells[y * scene.width + x] as Material),
      );
    }
  return { ...point, tick: scene.tick, cells };
}
export function materialName(material: Material | null, name: string) {
  return material === null
    ? "Outside the world"
    : material === 0
      ? "Empty"
      : material === 7
        ? name || "Your material"
        : MATERIALS.find((item) => item.id === material)!.name;
}

/** An explicit authored example in the current scene; the caller preserves a branch first. */
export function placeContactPair(scene: Scene) {
  const point = { x: 48, y: 31 };
  for (let y = 28; y <= 34; y++)
    for (let x = 45; x <= 52; x++) paint(scene, x, y, 0, 0);
  for (let x = 47; x <= 50; x++) paint(scene, x, 32, 3, 0);
  paint(scene, 50, 31, 3, 0);
  paint(scene, 48, 31, 7, 0);
  const neighbor = scene.rule.contact === "none" ? "water" : scene.rule.contact;
  paint(
    scene,
    49,
    31,
    MATERIALS.find((item) => item.name.toLowerCase() === neighbor)!.id,
    0,
  );
  return point;
}

export const materialSourceMarkers = {
  contact: {
    start: "      if (\n        cell === 7",
    end: "\n      if (cell === 5)",
    after: "export function step(",
  },
  movement: {
    start: "      const motion: Motion =",
    end: "\n    }\n  scene.tick++",
    after: "export function step(",
  },
  jev: {
    start: "export function ruleRequest(",
    end: "/** Invalidate pending model work",
  },
} satisfies Record<string, SourceMarkers>;
