/**
 * Grid items: a small maze with an agent A, a key K, a locked door D and an exit E. The state
 * is the picture only; breadth-first search over (square, has key) works out the answers.
 */
import { rng, type Item } from "./items";

const LEGEND =
  "Rows run top to bottom. '#' is a wall, '.' is open floor, A is the agent, K is the key, D is a locked door and E is the exit. The agent moves one square up, down, left or right per step. Stepping onto K picks up the key. The agent can only step onto D while carrying the key.";

const MOVES = [
  ["up", 0, -1],
  ["down", 0, 1],
  ["left", -1, 0],
  ["right", 1, 0],
] as const;

type Move = (typeof MOVES)[number][0];

type Cell = { x: number; y: number };

const find = (rows: string[], ch: string): Cell | null => {
  for (let y = 0; y < rows.length; y++) {
    const x = rows[y].indexOf(ch);

    if (x >= 0) return { x, y };
  }

  return null;
};

/**
 * Shortest steps from `from` to every square, where a door is passable only with the key.
 * `withKey` starts carrying the key; stepping on K picks it up. Returns steps to reach `to`
 * with or without having the key, and the first moves of all shortest routes.
 */
export function solve(rows: string[], from: Cell, to: Cell, withKey = false) {
  const h = rows.length,
    w = rows[0].length;

  const key = (x: number, y: number, k: boolean) => `${x},${y},${k ? 1 : 0}`;
  const dist = new Map<string, number>();
  const first = new Map<string, Set<Move>>();
  const start = key(from.x, from.y, withKey || rows[from.y][from.x] === "K");

  dist.set(start, 0);
  first.set(start, new Set());

  const queue: [number, number, boolean][] = [
    [from.x, from.y, withKey || rows[from.y][from.x] === "K"],
  ];

  for (let i = 0; i < queue.length; i++) {
    const [x, y, k] = queue[i];
    const here = key(x, y, k);
    const d = dist.get(here) ?? 0;
    const firsts = first.get(here) ?? new Set<Move>();

    for (const [name, dx, dy] of MOVES) {
      const nx = x + dx,
        ny = y + dy;

      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const c = rows[ny][nx];

      if (c === "#" || (c === "D" && !k)) continue;
      const nk = k || c === "K";
      const next = key(nx, ny, nk);
      const via = d === 0 ? new Set<Move>([name]) : firsts;

      if (!dist.has(next)) {
        dist.set(next, d + 1);
        first.set(next, new Set(via));
        queue.push([nx, ny, nk]);
      } else if (dist.get(next) === d + 1) {
        const set = first.get(next);

        for (const m of via) set?.add(m);
      }
    }
  }

  const without = dist.get(key(to.x, to.y, false));
  const withK = dist.get(key(to.x, to.y, true));
  const best = [without, withK].filter((v): v is number => v !== undefined);
  const steps = best.length ? Math.min(...best) : null;

  const moves = new Set<Move>();

  for (const [k, d] of [
    [false, without],
    [true, withK],
  ] as const)
    if (d !== undefined && d === steps)
      for (const m of first.get(key(to.x, to.y, k)) ?? []) moves.add(m);

  return { steps, withoutKey: without ?? null, firstMoves: [...moves] };
}

/** The four questions a grid can ask, with answers from `solve`. Some apply only sometimes. */
export function gridTruth(rows: string[]) {
  const a = find(rows, "A"),
    k = find(rows, "K"),
    e = find(rows, "E");

  if (!a || !k || !e) throw new Error("A grid needs A, K and E.");
  const toExit = solve(rows, a, e);
  const toKey = solve(rows, a, k);

  return {
    reachable: toExit.steps !== null,
    needsKey: toExit.steps !== null ? toExit.withoutKey === null : null,
    exitSteps: toExit.steps,
    firstStepToKey:
      toKey.steps !== null && toKey.firstMoves.length === 1 ? toKey.firstMoves[0] : null,
    keySteps: toKey.steps,
  };
}

/** Distance levels for the score question. */
export const DISTANCE_LEVELS = [
  "The exit is fewer than 8 steps away",
  "The exit is 8 to 14 steps away",
  "The exit is 15 or more steps away, or cannot be reached",
];

export const distanceLevel = (steps: number | null) =>
  steps === null || steps >= 15 ? 2 : steps >= 8 ? 1 : 0;

function layout(seed: number) {
  const random = rng(seed);
  const n = 7 + Math.floor(random() * 3);

  const g: string[][] = Array.from({ length: n }, (_, y) =>
    Array.from({ length: n }, (_, x) =>
      x === 0 || y === 0 || x === n - 1 || y === n - 1 ? "#" : ".",
    ),
  );

  // Half the grids are vaults: a wall across the middle with one gap, and the door in it.
  const vault = random() < 0.5;
  let door: Cell | null = null;

  if (vault) {
    const vertical = random() < 0.5;
    const line = 2 + Math.floor(random() * (n - 4));
    const gap = 1 + Math.floor(random() * (n - 2));

    for (let i = 1; i < n - 1; i++) {
      if (vertical) g[i][line] = "#";
      else g[line][i] = "#";
    }

    door = vertical ? { x: line, y: gap } : { x: gap, y: line };
    g[door.y][door.x] = "D";
  }

  const density = 0.12 + random() * 0.18;

  for (let y = 1; y < n - 1; y++)
    for (let x = 1; x < n - 1; x++) if (g[y][x] === "." && random() < density) g[y][x] = "#";

  const open = () => {
    const cells: Cell[] = [];

    for (let y = 1; y < n - 1; y++)
      for (let x = 1; x < n - 1; x++) if (g[y][x] === ".") cells.push({ x, y });

    return cells;
  };

  if (!door) {
    const spots = open();
    const d = spots[Math.floor(random() * spots.length)];

    if (!d) return null;
    door = d;
    g[d.y][d.x] = "D";
  }

  // In most vaults the agent and key start on one side and the exit waits on the other, so the
  // key matters; elsewhere everything is placed at random.
  const d = door;

  const vertical =
    vault && (g[d.y - 1]?.[d.x] === "#" || g[d.y + 1]?.[d.x] === "#") && g[d.y][d.x - 1] !== "#";

  const sideOf = (c: Cell) => (vertical ? Math.sign(c.x - d.x) : Math.sign(c.y - d.y));
  const split = vault && random() < 0.7;
  const near = random() < 0.5 ? -1 : 1;

  for (const ch of ["A", "K", "E"]) {
    const want = ch === "E" ? -near : near;
    const all = open();
    const spots = split ? all.filter((c) => sideOf(c) === want) : all;
    const c = spots[Math.floor(random() * spots.length)];

    if (!c) return null;
    g[c.y][c.x] = ch;
  }

  return g.map((row) => row.join(""));
}

export function gridItem(seed: number): Item | null {
  const rows = layout(seed);

  if (!rows) return null;
  const t = gridTruth(rows);

  // Too easy to be worth a question: exit or key right next to the agent.
  if ((t.exitSteps !== null && t.exitSteps < 4) || (t.keySteps !== null && t.keySteps < 3))
    return null;

  const questions: Item["questions"] = {
    can_exit: { type: "noul", instructions: "The agent can reach the exit E." },
    exit_distance: {
      type: "score",
      instructions:
        "How many steps does the shortest route to the exit take, picking up the key on the way if that is needed?",
      criteria: DISTANCE_LEVELS,
    },
  };

  const truth: Item["truth"] = {
    can_exit: t.reachable,
    exit_distance: distanceLevel(t.exitSteps),
  };

  if (t.needsKey !== null) {
    questions.needs_key = {
      type: "noul",
      instructions:
        "Every route from the agent to the exit needs the key (it has to go through the door).",
    };
    truth.needs_key = t.needsKey;
  }

  if (t.firstStepToKey) {
    questions.first_step_to_key = {
      type: "choice",
      instructions: "What is the agent's first step on the shortest route to the key K?",
      criteria: { up: "Up", down: "Down", left: "Left", right: "Right" },
    };
    truth.first_step_to_key = t.firstStepToKey;
  }

  const hard = t.exitSteps !== null && t.exitSteps >= 12 ? 1 : 0;

  return {
    id: `grid-${seed}`,
    kind: "grid",
    seed,
    difficulty: hard + (t.needsKey ? 1 : 0),
    state: { legend: LEGEND, grid: rows },
    questions,
    truth,
  };
}
