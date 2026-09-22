import { describe, expect, test } from "bun:test";
import {
  cameraToNode,
  FIELD_MAX_ZOOM,
  FIELD_MIN_ZOOM,
  layoutField,
  navigateField,
  visibleNodes,
  zoomAt,
  type Camera,
  type FieldNode,
} from "./field-layout";

const camera: Camera = { x: 0, y: 0, zoom: 1 };
const box = (id: number, x: number, y: number): FieldNode => ({
  id,
  x,
  y,
  width: 140,
  height: 170,
});

describe("ranked geometry", () => {
  test("retains rank order, centers the first result and has stable prefixes", () => {
    const ids = [73, 0, -5, 91, 28, 19, 24, 88, 41, 70, 82];
    const before = [...ids];
    const nodes = layoutField(ids);
    expect(nodes.map((node) => node.id)).toEqual(ids);
    expect(nodes[0].x + nodes[0].width / 2).toBe(0);
    expect(nodes[0].y + nodes[0].height / 2).toBe(0);
    expect(layoutField(ids)).toEqual(nodes);
    expect(layoutField([...ids, 999, 1000]).slice(0, ids.length)).toEqual(
      nodes,
    );
    expect(ids).toEqual(before);
    expect(layoutField([])).toEqual([]);
  });

  test("512 boxes remain finite, separated and distributed around the origin", () => {
    const nodes = layoutField(Array.from({ length: 512 }, (_, i) => i));
    expect(
      nodes.every((node) => Object.values(node).every(Number.isFinite)),
    ).toBe(true);
    expect(nodes.some((node) => node.x < -500)).toBe(true);
    expect(nodes.some((node) => node.x > 500)).toBe(true);
    expect(nodes.some((node) => node.y < -500)).toBe(true);
    expect(nodes.some((node) => node.y > 500)).toBe(true);
    const overlaps: [number, number][] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (
          a.x < b.x + b.width &&
          a.x + a.width > b.x &&
          a.y < b.y + b.height &&
          a.y + a.height > b.y
        )
          overlaps.push([a.id, b.id]);
      }
    }
    expect(overlaps).toEqual([]);
  });

  test("rejects duplicate and nonfinite identities before creating unusable keys", () => {
    expect(() => layoutField([1, 1])).toThrow("finite and unique");
    expect(() => layoutField([NaN])).toThrow("finite and unique");
    expect(() => layoutField([Infinity])).toThrow("finite and unique");
  });
});

describe("viewport culling", () => {
  test("includes intersecting boxes and a fixed 180 screen-pixel margin", () => {
    const nodes = [box(1, 200, -85), box(2, 379, -85), box(3, 381, -85)];
    const viewport = { width: 400, height: 300 };
    expect(visibleNodes(nodes, camera, viewport).map((n) => n.id)).toEqual([
      1, 2,
    ]);
    const zoomed = { x: -80, y: 50, zoom: 2 };
    // Same screen-space rectangles at another camera scale/translation.
    const transformed = nodes.map((node) => ({
      ...node,
      x: (node.x - zoomed.x) / zoomed.zoom,
      y: (node.y - zoomed.y) / zoomed.zoom,
      width: node.width / zoomed.zoom,
      height: node.height / zoomed.zoom,
    }));
    expect(
      visibleNodes(transformed, zoomed, viewport).map((n) => n.id),
    ).toEqual([1, 2]);
    expect(visibleNodes(nodes, camera, viewport, 3).map((n) => n.id)).toEqual([
      1, 2, 3,
    ]);
  });

  test("keeps every visible card and an offscreen active ID", () => {
    const nodes = layoutField(Array.from({ length: 1000 }, (_, i) => i));
    const viewport = { width: 4000, height: 4000 };
    const result = visibleNodes(nodes, camera, viewport, 999);
    expect(result.length).toBeGreaterThan(72);
    expect(result.some((node) => node.id === 0)).toBe(true);
    expect(result.some((node) => node.id === 999)).toBe(true);
    expect(new Set(result.map((node) => node.id)).size).toBe(result.length);
    expect(result.map((node) => node.id)).toEqual(
      result.map((node) => node.id).sort((a, b) => a - b),
    );
    const far = { x: 1_000_000, y: -1_000_000, zoom: 1 };
    expect(visibleNodes(nodes, far, viewport)).toEqual([]);
    expect(visibleNodes(nodes, far, viewport, 0)).toEqual([nodes[0]]);
  });

  test("overview does not silently cap visible or overscan items", () => {
    const outside = Array.from({ length: 80 }, (_, id) => box(id, 250, -85));
    const inside = box(100, -70, -85);
    const result = visibleNodes([...outside, inside], camera, {
      width: 400,
      height: 300,
    });
    expect(result).toHaveLength(81);
    expect(result).toContain(inside);
  });

  test("a hidden viewport renders only its active item", () => {
    const nodes = layoutField([0, 1, 2]);
    expect(visibleNodes(nodes, camera, { width: 0, height: 500 })).toEqual([]);
    expect(visibleNodes(nodes, camera, { width: 500, height: 0 }, 0)).toEqual([
      nodes[0],
    ]);
  });
});

describe("camera and keyboard movement", () => {
  test("zoom preserves the pointed world position, including both clamp boundaries", () => {
    const before = { x: 103, y: -47, zoom: 0.8 };
    const point = { x: 190, y: -120 };
    const world = {
      x: (point.x - before.x) / before.zoom,
      y: (point.y - before.y) / before.zoom,
    };
    for (const [requested, actual] of [
      [1.7, 1.7],
      [0.01, FIELD_MIN_ZOOM],
      [9, FIELD_MAX_ZOOM],
    ]) {
      const after = zoomAt(before, requested, point);
      expect(after.zoom).toBe(actual);
      expect(after.x + world.x * after.zoom).toBeCloseTo(point.x, 10);
      expect(after.y + world.y * after.zoom).toBeCloseTo(point.y, 10);
    }
    expect(before).toEqual({ x: 103, y: -47, zoom: 0.8 });
    expect(() => zoomAt(before, NaN, point)).toThrow("finite");
  });

  test("focusing a node centers it at every viewport size without changing zoom", () => {
    const node = box(17, 530, -470);
    const before = { x: 200, y: -80, zoom: 1.6 };
    for (const viewport of [
      { width: 390, height: 600 },
      { width: 1440, height: 900 },
    ]) {
      const after = cameraToNode(before, node, viewport);
      expect(
        viewport.width / 2 + after.x + (node.x + node.width / 2) * after.zoom,
      ).toBeCloseTo(viewport.width / 2, 10);
      expect(
        viewport.height / 2 + after.y + (node.y + node.height / 2) * after.zoom,
      ).toBeCloseTo(viewport.height / 2, 10);
      expect(after.zoom).toBe(before.zoom);
    }
  });

  test("arrow navigation selects the nearest directional center and stays at an edge", () => {
    const nodes = [
      box(0, -70, -85),
      box(1, -234, -85),
      box(2, 94, -85),
      box(3, -70, -279),
      box(4, -70, 109),
    ];
    expect(navigateField(nodes, 0, "left")).toBe(1);
    expect(navigateField(nodes, 0, "right")).toBe(2);
    expect(navigateField(nodes, 0, "up")).toBe(3);
    expect(navigateField(nodes, 0, "down")).toBe(4);
    expect(navigateField(nodes, 1, "left")).toBe(1);
    expect(navigateField(nodes, 999, "left")).toBe(999);
    expect(navigateField([], 0, "right")).toBe(0);
  });

  test("sparse directional navigation uses distance rather than input rank", () => {
    const nodes = [
      box(0, 0, 0),
      box(1, 600, 0),
      box(2, 180, 90),
      box(3, 0, 170),
    ];
    expect(navigateField(nodes, 0, "right")).toBe(2);
    expect(navigateField(nodes, 0, "down")).toBe(3);
    const tied = [box(0, 0, 0), box(2, 160, 30), box(1, 160, -30)];
    expect(navigateField(tied, 0, "right")).toBe(2);
  });
});
