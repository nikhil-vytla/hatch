export const COLS = 10;
export const ROWS = 20;
export const STEP_MS = 20;
export const PIECES = ["I", "O", "T", "S", "Z", "J", "L"] as const;
export type Piece = (typeof PIECES)[number];
export type Command = "left" | "right" | "cw" | "ccw" | "soft" | "drop" | "hold" | "wait";
export type Pose = { type: Piece; x: number; y: number; rotation: number };
export type Game = {
  board: number[][]; active: Pose; queue: Piece[]; rng: number; pieceId: number;
  held: Piece | null; canHold: boolean; score: number; lines: number; level: number;
  status: "playing" | "over"; timeMs: number; gravityMs: number; lockMs: number;
  lockResets: number; pieces: number; lastClear: number;
};
const SHAPES: Record<Piece, string[]> = {
  I: ["....", "IIII", "....", "...."], O: ["OO", "OO"],
  T: [".T.", "TTT", "..."], S: [".SS", "SS.", "..."],
  Z: ["ZZ.", ".ZZ", "..."], J: ["J..", "JJJ", "..."], L: ["..L", "LLL", "..."],
};
export function cells(pose: Pose): [number, number][] {
  const matrix = SHAPES[pose.type], size = matrix.length;
  const result: [number, number][] = [];
  matrix.forEach((row, y) => [...row].forEach((v, x) => {
    if (v === ".") return;
    let a = x, b = y;
    for (let r = 0; r < (pose.type === "O" ? 0 : pose.rotation); r++) [a, b] = [size - 1 - b, a];
    result.push([pose.x + a, pose.y + b]);
  }));
  return result;
}
export function fits(board: number[][], pose: Pose) {
  return cells(pose).every(([x, y]) => x >= 0 && x < COLS && y >= -4 && y < ROWS && (y < 0 || board[y][x] === 0));
}
function random(g: Game) { g.rng = (Math.imul(g.rng, 1664525) + 1013904223) >>> 0; return g.rng / 4294967296; }
function fillQueue(g: Game) {
  while (g.queue.length < 7) {
    const bag = [...PIECES];
    for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(random(g) * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    g.queue.push(...bag);
  }
}
function spawn(g: Game, heldType?: Piece) {
  fillQueue(g);
  const type = heldType ?? g.queue.shift()!;
  g.active = { type, x: type === "O" ? 4 : 3, y: -1, rotation: 0 };
  g.pieceId++; g.gravityMs = 0; g.lockMs = 0; g.lockResets = 0;
  fillQueue(g);
  if (!fits(g.board, g.active)) g.status = "over";
}
export function createGame(seed = 19): Game {
  const g: Game = { board: Array.from({ length: ROWS }, () => Array(COLS).fill(0)), active: { type: "I", x: 3, y: -1, rotation: 0 }, queue: [], rng: seed >>> 0, pieceId: 0, held: null, canHold: true, score: 0, lines: 0, level: 1, status: "playing", timeMs: 0, gravityMs: 0, lockMs: 0, lockResets: 0, pieces: 0, lastClear: 0 };
  spawn(g); return g;
}
export const cloneGame = (g: Game): Game => structuredClone(g);
export function moved(board: number[][], p: Pose, command: Command): Pose | null {
  if (command === "left" || command === "right" || command === "soft") {
    const next = { ...p, x: p.x + (command === "left" ? -1 : command === "right" ? 1 : 0), y: p.y + (command === "soft" ? 1 : 0) };
    return fits(board, next) ? next : null;
  }
  if (command === "cw" || command === "ccw") {
    const rotation = (p.rotation + (command === "cw" ? 1 : 3)) % 4;
    for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [0, -2]]) {
      const next = { ...p, x: p.x + dx, y: p.y + dy, rotation };
      if (fits(board, next)) return next;
    }
  }
  return null;
}
export function ghost(g: Game, pose = g.active): Pose {
  let p = { ...pose }, next: Pose | null;
  while ((next = moved(g.board, p, "soft"))) p = next;
  return p;
}
function lock(g: Game) {
  const occupied = cells(g.active);
  if (occupied.some(([, y]) => y < 0)) { g.status = "over"; return; }
  occupied.forEach(([x, y]) => { g.board[y][x] = PIECES.indexOf(g.active.type) + 1; });
  const remaining = g.board.filter(row => row.some(v => v === 0));
  const cleared = ROWS - remaining.length;
  g.board = [...Array.from({ length: cleared }, () => Array(COLS).fill(0)), ...remaining];
  g.score += [0, 100, 300, 500, 800][cleared] * g.level;
  g.lines += cleared; g.level = 1 + Math.floor(g.lines / 10); g.pieces++; g.lastClear = cleared; g.canHold = true;
  spawn(g);
}
/** Mutates one owned game. Clock and RNG are entirely contained in Game. */
export function command(g: Game, input: Command) {
  if (g.status !== "playing" || input === "wait") return;
  if (input === "hold") {
    if (!g.canHold) return;
    const old = g.active.type, held = g.held;
    g.held = old; spawn(g, held ?? undefined); g.canHold = false; return;
  }
  if (input === "drop") { const p = ghost(g); g.score += (p.y - g.active.y) * 2; g.active = p; lock(g); return; }
  const grounded = !moved(g.board, g.active, "soft"), next = moved(g.board, g.active, input);
  if (next) {
    g.active = next;
    if (input === "soft") g.score++;
    if (grounded && g.lockResets < 15) { g.lockMs = 0; g.lockResets++; }
  }
}
export function gravityInterval(g: Game) { return Math.max(80, 900 * Math.pow(0.8, g.level - 1)); }
export function advanceGame(g: Game, ms: number) {
  if (g.status !== "playing") return;
  g.timeMs += ms; g.gravityMs += ms;
  const interval = gravityInterval(g);
  while (g.gravityMs >= interval) {
    g.gravityMs -= interval;
    const next = moved(g.board, g.active, "soft");
    if (next) g.active = next;
  }
  if (!moved(g.board, g.active, "soft")) { g.lockMs += ms; if (g.lockMs >= 450) lock(g); }
  else g.lockMs = 0;
}
export type Features = { lines: number; holes: number; height: number; aggregateHeight: number; bumpiness: number; topOut: boolean };
export function boardFeatures(board: number[][]): Omit<Features, "lines" | "topOut"> {
  const heights = Array.from({ length: COLS }, (_, x) => { const y = board.findIndex(row => row[x] !== 0); return y < 0 ? 0 : ROWS - y; });
  let holes = 0;
  for (let x = 0; x < COLS; x++) for (let y = ROWS - heights[x]; y < ROWS; y++) if (board[y][x] === 0) holes++;
  return { holes, height: Math.max(...heights), aggregateHeight: heights.reduce((a, b) => a + b, 0), bumpiness: heights.slice(1).reduce((a, h, i) => a + Math.abs(h - heights[i]), 0) };
}
export type Landing = { id: string; pose: Pose; path: Command[]; features: Features };
export function landings(g: Game): Landing[] {
  if (g.status !== "playing") return [];
  const key = (p: Pose) => `${p.x},${p.y},${p.rotation}`;
  const seen = new Set([key(g.active)]), found = new Map<string, Landing>();
  const queue: { pose: Pose; path: Command[] }[] = [{ pose: { ...g.active }, path: [] }];
  for (let i = 0; i < queue.length; i++) {
    const { pose, path } = queue[i], landing = ghost(g, pose);
    const id = cells(landing).sort(([a, b], [c, d]) => b - d || a - c).map(([x, y]) => `${x}_${y}`).join("-");
    if (!found.has(id)) {
      const preview = cloneGame(g); preview.active = landing; const lines = preview.lines;
      lock(preview);
      found.set(id, { id, pose: landing, path: [...path, "drop"], features: { ...boardFeatures(preview.board), lines: preview.lines - lines, topOut: preview.status === "over" } });
    }
    // Reachable landing routes include slides beneath overhangs. Pose bounds make this finite.
    for (const input of ["left", "right", "cw", "ccw", "soft"] as Command[]) {
      const next = moved(g.board, pose, input);
      if (next && !seen.has(key(next))) { seen.add(key(next)); queue.push({ pose: next, path: [...path, input] }); }
    }
  }
  return [...found.values()];
}
export type Intent = "clear_lines" | "keep_low" | "avoid_holes";
export function chooseLanding(options: Landing[], intent: Intent = "avoid_holes") {
  const value = (l: Landing) => {
    const f = l.features;
    return (f.topOut ? -1e6 : 0) + f.lines * (intent === "clear_lines" ? 12 : 8) - f.holes * (intent === "avoid_holes" ? 10 : 7) - f.aggregateHeight * (intent === "keep_low" ? 0.9 : 0.5) - f.bumpiness * 0.3 - f.height * 0.6;
  };
  return [...options].sort((a, b) => value(b) - value(a) || a.path.length - b.path.length || a.id.localeCompare(b.id))[0];
}
