/**
 * PROTOTYPE (Eyes against state): a pixel-reading stand-in for a vision model.
 *
 * It draws the Snake board to a canvas, degrades it like a cheap camera (lower resolution,
 * per-pixel noise, a drifting glare spot), then reads every cell back by nearest colour. What it
 * reads is a guess at the game state, so misreads are real misreads of pixels, not invented ones.
 * It is NOT a vision-language model; the page says so. A recorded GPU run can replace it later.
 */
import type { Point, State } from "../../local-models-and-games/arcade/engine";

export type Camera = { id: string; label: string; px: number; noise: number; glare: number };

export const CAMERAS: Camera[] = [
  { id: "sharp", label: "Sharp screen capture", px: 100, noise: 0, glare: 0 },
  { id: "phone", label: "Phone camera", px: 50, noise: 30, glare: 0.5 },
  { id: "murky", label: "Murky webcam", px: 30, noise: 48, glare: 0.85 },
];

const PALETTE = {
  floor: [255, 244, 224],
  body: [47, 158, 110],
  head: [23, 20, 15],
  food: [240, 83, 45],
} as const;

type Kind = keyof typeof PALETTE;

/** mulberry32, so the same seed and tick always give the same noise. */
function rng(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;

    let t = a;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgb = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** The clean frame: 10 px per cell, the way the game is drawn. */
export function drawClean(ctx: CanvasRenderingContext2D, s: State, cell = 10) {
  ctx.fillStyle = rgb(PALETTE.floor);
  ctx.fillRect(0, 0, cell * 10, cell * 10);
  ctx.fillStyle = rgb(PALETTE.body);

  for (const p of s.snake!.slice(1)) ctx.fillRect(p.x * cell, p.y * cell, cell, cell);

  ctx.fillStyle = rgb(PALETTE.head);
  ctx.fillRect(s.snake![0].x * cell, s.snake![0].y * cell, cell, cell);
  ctx.fillStyle = rgb(PALETTE.food);
  ctx.beginPath();
  ctx.arc((s.food!.x + 0.5) * cell, (s.food!.y + 0.5) * cell, cell * 0.38, 0, Math.PI * 2);
  ctx.fill();
}

export type Perceived = {
  cells: Kind[][];
  snake: Point[];
  food: Point | null;
  heading: number;
  misreads: { x: number; y: number; truth: Kind; seen: Kind }[];
  ms: number;
  /** What the camera delivered, for display. */
  image: ImageData;
};

function truthAt(s: State, x: number, y: number): Kind {
  if (s.snake![0].x === x && s.snake![0].y === y) return "head";

  if (s.snake!.some((p) => p.x === x && p.y === y)) return "body";

  if (s.food!.x === x && s.food!.y === y) return "food";

  return "floor";
}

const DIRS = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

let clean: HTMLCanvasElement | null = null;
let small: HTMLCanvasElement | null = null;

/** Draw, degrade and read one frame; `ms` is the measured time for all three steps. */
export function perceive(s: State, cam: Camera, track: Track | null): Perceived {
  const t0 = performance.now();

  clean ??= document.createElement("canvas");
  small ??= document.createElement("canvas");
  clean.width = clean.height = 100;

  const c = clean.getContext("2d", { willReadFrequently: true })!;

  drawClean(c, s);

  if (cam.glare > 0) {
    // A soft glare spot that drifts with the tick, like a window reflected in the screen.
    const r = rng(s.seed * 7919 + s.tick);
    const gx = 50 + Math.sin(s.tick / 9) * 35 + (r() - 0.5) * 10;
    const gy = 50 + Math.cos(s.tick / 13) * 35 + (r() - 0.5) * 10;
    const g = c.createRadialGradient(gx, gy, 2, gx, gy, 26);

    g.addColorStop(0, `rgba(255,255,255,${cam.glare})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g;
    c.fillRect(0, 0, 100, 100);
  }

  small.width = small.height = cam.px;

  const sc = small.getContext("2d", { willReadFrequently: true })!;

  sc.imageSmoothingEnabled = true;
  sc.drawImage(clean, 0, 0, cam.px, cam.px);

  const img = sc.getImageData(0, 0, cam.px, cam.px);

  if (cam.noise > 0) {
    const r = rng(s.seed * 104729 + s.tick * 31);

    for (let i = 0; i < img.data.length; i += 4) {
      const n = (r() + r() + r() - 1.5) * cam.noise;

      img.data[i] += n;
      img.data[i + 1] += n;
      img.data[i + 2] += n;
    }
  }

  const cells: Kind[][] = [];
  const misreads: Perceived["misreads"] = [];
  const per = cam.px / 10;

  for (let y = 0; y < 10; y++) {
    const row: Kind[] = [];

    for (let x = 0; x < 10; x++) {
      // Average the middle of the cell, then take the nearest palette colour.
      let R = 0;
      let G = 0;
      let B = 0;
      let n = 0;
      const x0 = Math.floor((x + 0.3) * per);
      const x1 = Math.max(x0 + 1, Math.ceil((x + 0.7) * per));
      const y0 = Math.floor((y + 0.3) * per);
      const y1 = Math.max(y0 + 1, Math.ceil((y + 0.7) * per));

      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * cam.px + xx) * 4;

          R += img.data[i];
          G += img.data[i + 1];
          B += img.data[i + 2];
          n++;
        }

      R /= n;
      G /= n;
      B /= n;

      let best: Kind = "floor";
      let bestD = Infinity;

      for (const k of Object.keys(PALETTE) as Kind[]) {
        const p = PALETTE[k];
        const d = (p[0] - R) ** 2 + (p[1] - G) ** 2 + (p[2] - B) ** 2;

        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }

      row.push(best);

      const truth = truthAt(s, x, y);

      if (truth !== best) misreads.push({ x, y, truth, seen: best });
    }

    cells.push(row);
  }

  // Rebuild the game state the camera implies: head, body chain from the head, food, heading.
  const heads: Point[] = [];
  const bodies = new Set<string>();
  let food: Point | null = null;

  cells.forEach((row, y) =>
    row.forEach((k, x) => {
      if (k === "head") heads.push({ x, y });
      else if (k === "body") bodies.add(`${x},${y}`);
      else if (k === "food" && !food) food = { x, y };
    }),
  );

  // Pixels show which cells are body, not the order. Like a real tracker, use the order this lane
  // saw last frame: the new head, then last frame's snake for every cell still seen as body.
  // Nothing here reads the true state; a missed head or food falls back to memory, not the truth.
  const prev = track;
  const head = heads[0] ?? prev?.snake[0] ?? { x: 4, y: 5 };
  const snake: Point[] = [head];

  for (const p of prev?.snake ?? []) {
    const k = `${p.x},${p.y}`;

    if (bodies.has(k)) {
      bodies.delete(k);
      snake.push(p);
    }
  }

  let cur = snake[snake.length - 1];

  for (;;) {
    const next = DIRS.map((d) => ({ x: cur.x + d.x, y: cur.y + d.y })).find((p) => bodies.has(`${p.x},${p.y}`));

    if (!next) break;

    bodies.delete(`${next.x},${next.y}`);
    snake.push(next);
    cur = next;
  }

  // Body cells that don't chain still block moves, so keep them at the tail end.
  for (const k of bodies) {
    const [x, y] = k.split(",").map(Number);

    snake.push({ x, y });
  }

  let heading = prev?.heading ?? 1;
  const moved = prev && (head.x !== prev.snake[0].x || head.y !== prev.snake[0].y);
  const from = moved ? prev.snake[0] : snake[1];

  if (from) {
    const h = DIRS.findIndex((d) => d.x === head.x - from.x && d.y === head.y - from.y);

    if (h >= 0) heading = h;
  }

  const seenFood = food ?? prev?.food ?? null;
  const ms = performance.now() - t0;

  return {
    cells,
    snake,
    food: seenFood,
    heading,
    misreads,
    ms,
    image: new ImageData(new Uint8ClampedArray(img.data), cam.px, cam.px),
  };
}

/** What this lane carries from frame to frame: only what it perceived before. */
export type Track = { snake: Point[]; heading: number; food: Point | null };

export const trackOf = (p: Perceived): Track => ({ snake: p.snake, heading: p.heading, food: p.food });

/** The game state as the camera saw it, for the same greedy rule to decide on. */
export function seenState(s: State, p: Perceived): State {
  // With no food seen yet, put it out of reach so the rule just avoids collisions.
  return { ...s, snake: p.snake, food: p.food ?? { x: -100, y: -100 }, heading: p.heading };
}
