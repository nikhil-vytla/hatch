/** Ranked display geometry. Position conveys rank bands, not embedding distance. */
export type FieldNode = {
  id: number;
  /** World-space top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Translation is in screen pixels, measured from the viewport center. */
export type Camera = { x: number; y: number; zoom: number };
export type Viewport = { width: number; height: number };
export type Direction = "left" | "right" | "up" | "down";

export const FIELD_MIN_ZOOM = 0.45;
export const FIELD_MAX_ZOOM = 2.5;
export const FIELD_OVERSCAN = 180;

const CARD_WIDTH = 140;
const CARD_HEIGHT = 170;
const COLUMN_STEP = CARD_WIDTH + 24;
const ROW_STEP = CARD_HEIGHT + 24;

/** Input order is rank order. Adding trailing IDs does not move existing boxes. */
export function layoutField(ids: readonly number[]): FieldNode[] {
  if (
    ids.some((id) => !Number.isFinite(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new RangeError("Field IDs must be finite and unique.");

  const nodes: FieldNode[] = [];
  const add = (column: number, row: number) => {
    if (nodes.length === ids.length) return;
    nodes.push({
      id: ids[nodes.length],
      x: column * COLUMN_STEP - CARD_WIDTH / 2,
      y: row * ROW_STEP - CARD_HEIGHT / 2,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    });
  };
  add(0, 0);
  for (let radius = 1; nodes.length < ids.length; radius++) {
    const ring: { column: number; row: number }[] = [];
    for (let column = -radius; column <= radius; column++) {
      ring.push({ column, row: -radius }, { column, row: radius });
    }
    for (let row = -radius + 1; row < radius; row++) {
      ring.push({ column: -radius, row }, { column: radius, row });
    }
    const distance = ({ column, row }: (typeof ring)[number]) =>
      (column * COLUMN_STEP) ** 2 + (row * ROW_STEP) ** 2;
    const angle = ({ column, row }: (typeof ring)[number]) =>
      (Math.atan2(column, -row) + 2 * Math.PI) % (2 * Math.PI);
    ring.sort((a, b) => distance(a) - distance(b) || angle(a) - angle(b));
    for (const { column, row } of ring) add(column, row);
  }
  return nodes;
}

function checkCamera(camera: Camera) {
  if (
    !Number.isFinite(camera.x) ||
    !Number.isFinite(camera.y) ||
    !Number.isFinite(camera.zoom) ||
    camera.zoom <= 0
  )
    throw new RangeError(
      "Camera coordinates must be finite with positive zoom.",
    );
}

function checkViewport(viewport: Viewport) {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width < 0 ||
    viewport.height < 0
  )
    throw new RangeError("Viewport dimensions must be finite and nonnegative.");
}

/** Viewport plus fixed overscan, with the active work retained for keyboard focus. */
export function visibleNodes(
  nodes: readonly FieldNode[],
  camera: Camera,
  viewport: Viewport,
  activeId?: number,
): FieldNode[] {
  checkCamera(camera);
  checkViewport(viewport);
  return nodes.filter((node) => {
    if (node.id === activeId) return true;
    if (!viewport.width || !viewport.height) return false;
    const left = camera.x + node.x * camera.zoom;
    const top = camera.y + node.y * camera.zoom;
    return (
      left + node.width * camera.zoom >= -viewport.width / 2 - FIELD_OVERSCAN &&
      left <= viewport.width / 2 + FIELD_OVERSCAN &&
      top + node.height * camera.zoom >=
        -viewport.height / 2 - FIELD_OVERSCAN &&
      top <= viewport.height / 2 + FIELD_OVERSCAN
    );
  });
}

/** point is a screen offset from the viewport center, not a client coordinate. */
export function zoomAt(
  camera: Camera,
  nextZoom: number,
  point: { x: number; y: number },
): Camera {
  checkCamera(camera);
  if (![nextZoom, point.x, point.y].every(Number.isFinite))
    throw new RangeError("Zoom and anchor coordinates must be finite.");
  const zoom = Math.min(FIELD_MAX_ZOOM, Math.max(FIELD_MIN_ZOOM, nextZoom));
  const ratio = zoom / camera.zoom;
  return {
    x: point.x - (point.x - camera.x) * ratio,
    y: point.y - (point.y - camera.y) * ratio,
    zoom,
  };
}

export function cameraToNode(
  camera: Camera,
  node: FieldNode,
  viewport: Viewport,
): Camera {
  checkCamera(camera);
  checkViewport(viewport);
  // The world origin already maps to the viewport center, so its size cancels.
  return {
    x: -(node.x + node.width / 2) * camera.zoom,
    y: -(node.y + node.height / 2) * camera.zoom,
    zoom: camera.zoom,
  };
}

/** Closest center in the requested half-plane. Ties prefer alignment, then rank. */
export function navigateField(
  nodes: readonly FieldNode[],
  activeId: number,
  direction: Direction,
): number {
  const active = nodes.find((node) => node.id === activeId);
  if (!active) return activeId;
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  let best = activeId;
  let bestDistance = Infinity;
  let bestOffset = Infinity;
  for (const node of nodes) {
    if (node.id === activeId) continue;
    const dx = node.x + node.width / 2 - (active.x + active.width / 2);
    const dy = node.y + node.height / 2 - (active.y + active.height / 2);
    if ((horizontal ? dx : dy) * sign <= 0) continue;
    const distance = dx ** 2 + dy ** 2;
    const offset = Math.abs(horizontal ? dy : dx);
    if (
      distance < bestDistance ||
      (distance === bestDistance && offset < bestOffset)
    ) {
      best = node.id;
      bestDistance = distance;
      bestOffset = offset;
    }
  }
  return best;
}
