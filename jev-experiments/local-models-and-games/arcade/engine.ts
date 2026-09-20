/** Original deterministic game rules shared by recorder and browser. */
export type Point = { x: number; y: number; z?: number };
export type Game = "snake" | "orbital";
export type State = {
  game: Game;
  seed: number;
  tick: number;
  score: number;
  status: "playing" | "won" | "lost" | "timeout";
  reason: string;
  rng: number;
  snake?: Point[];
  heading?: number;
  food?: Point;
  drone?: Point;
  cores?: Point[];
  hazards?: Point[];
  health?: number;
};
const dirs = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];
const flight: Record<string, Point> = {
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  up: { x: 0, y: 1, z: 0 },
  down: { x: 0, y: -1, z: 0 },
  north: { x: 0, y: 0, z: -1 },
  south: { x: 0, y: 0, z: 1 },
};
function random(s: State) {
  s.rng = (Math.imul(s.rng, 1664525) + 1013904223) >>> 0;
  return s.rng / 4294967296;
}
const equal = (a: Point, b: Point) =>
  a.x === b.x && a.y === b.y && (a.z ?? 0) === (b.z ?? 0);
const dist = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
const add = (a: Point, b: Point): Point => ({
  x: a.x + b.x,
  y: a.y + b.y,
  ...(a.z !== undefined ? { z: a.z + (b.z ?? 0) } : {}),
});
function food(s: State) {
  const empty: Point[] = [];
  for (let y = 0; y < 10; y++)
    for (let x = 0; x < 10; x++)
      if (!s.snake!.some((p) => p.x === x && p.y === y)) empty.push({ x, y });
  s.food = empty[Math.floor(random(s) * empty.length)];
}
export function initial(game: Game, seed: number): State {
  const s: State = {
    game,
    seed,
    tick: 0,
    score: 0,
    status: "playing",
    reason: "",
    rng: seed,
  };
  if (game === "snake") {
    s.snake = [
      { x: 4, y: 5 },
      { x: 3, y: 5 },
      { x: 2, y: 5 },
    ];
    s.heading = 1;
    food(s);
  } else {
    s.drone = { x: 0, y: 2, z: 0 };
    s.health = 3;
    s.cores = [];
    s.hazards = [];
    while (s.cores.length < 3) {
      const p = {
        x: Math.floor(random(s) * 11) - 5,
        y: 1 + Math.floor(random(s) * 4),
        z: Math.floor(random(s) * 11) - 5,
      };
      if (dist(p, s.drone) > 3 && !s.cores.some((c) => dist(c, p) < 2))
        s.cores.push(p);
    }
    while (s.hazards.length < 5) {
      const p = {
        x: Math.floor(random(s) * 11) - 5,
        y: 1 + Math.floor(random(s) * 4),
        z: Math.floor(random(s) * 11) - 5,
      };
      if (dist(p, s.drone) > 2 && !s.cores.some((c) => dist(c, p) < 1.5))
        s.hazards.push(p);
    }
  }
  return s;
}
export function options(s: State): Record<string, string> {
  if (s.game === "snake")
    return {
      left: "Turn 90 degrees left and move one cell",
      straight: "Continue forward one cell",
      right: "Turn 90 degrees right and move one cell",
    };
  return Object.fromEntries(
    Object.keys(flight).map((a) => [
      a,
      `Fly one unit ${a}. ${a === "up" ? "Increase altitude" : a === "down" ? "Decrease altitude" : "Keep altitude"}.`,
    ]),
  );
}
function snakeNext(s: State, action: string) {
  const offset = action === "left" ? -1 : action === "right" ? 1 : 0;
  const heading = (s.heading! + offset + 4) % 4;
  return { heading, next: add(s.snake![0], dirs[heading]) };
}
function collision(s: State, p: Point) {
  return (
    p.x < 0 ||
    p.y < 0 ||
    p.x >= 10 ||
    p.y >= 10 ||
    s
      .snake!.slice(0, equal(p, s.food!) ? undefined : -1)
      .some((q) => equal(p, q))
  );
}
export function observe(s: State) {
  if (s.game === "snake")
    return {
      board: "10 by 10. x increases right; y increases down.",
      head: s.snake![0],
      heading: ["north", "east", "south", "west"][s.heading!],
      food: s.food,
      body: s.snake,
      score: s.score,
      moves_left: 90 - s.tick,
      action_preview: Object.fromEntries(
        Object.keys(options(s)).map((a) => {
          const { next } = snakeNext(s, a);
          return [
            a,
            {
              next_cell: next,
              immediate_collision: collision(s, next),
              distance_to_food:
                Math.abs(next.x - s.food!.x) + Math.abs(next.y - s.food!.y),
            },
          ];
        }),
      ),
    };
  const goal = s.cores!.length
    ? s.cores!.reduce((a, b) => (dist(s.drone!, a) < dist(s.drone!, b) ? a : b))
    : { x: 0, y: 2, z: 0 };
  return {
    mission: s.cores!.length
      ? "Collect all three energy cores, then return to the beacon at (0,2,0)."
      : "All cores collected. Return to beacon (0,2,0).",
    position: s.drone,
    cores_remaining: s.cores,
    static_hazards: s.hazards,
    health: s.health,
    moves_left: 70 - s.tick,
    bounds: { x: [-6, 6], y: [0, 5], z: [-6, 6] },
    coordinates: "east +x, west -x, up +y, down -y, north -z, south +z",
    nearest_objective: goal,
    action_preview: Object.fromEntries(
      Object.entries(flight).map(([a, v]) => {
        const p = add(s.drone!, v);
        return [
          a,
          {
            next_position: p,
            out_of_bounds: outside(p),
            hazard_collision: s.hazards!.some((h) => dist(h, p) < 0.8),
            distance_to_nearest_objective: Number(dist(p, goal).toFixed(2)),
          },
        ];
      }),
    ),
  };
}
function outside(p: Point) {
  return Math.abs(p.x) > 6 || p.y < 0 || p.y > 5 || Math.abs(p.z!) > 6;
}
export function step(input: State, action: string): State {
  if (!Object.hasOwn(options(input), action))
    throw Error("Unknown game action");
  const s = structuredClone(input);
  if (s.status !== "playing") return s;
  s.tick++;
  if (s.game === "snake") {
    const { next, heading } = snakeNext(s, action);
    s.heading = heading;
    if (collision(s, next)) {
      s.status = "lost";
      s.reason = "Hit a wall or the snake body";
      return s;
    }
    s.snake!.unshift(next);
    if (equal(next, s.food!)) {
      s.score++;
      if (s.snake!.length === 100) {
        s.status = "won";
        s.reason = "Filled the board";
        return s;
      }
      food(s);
    } else s.snake!.pop();
    if (s.tick >= 90) {
      s.status = "timeout";
      s.reason = "90-move evaluation finished";
    }
  } else {
    const p = add(s.drone!, flight[action]);
    if (outside(p)) {
      s.health!--;
    } else {
      s.drone = p;
      if (s.hazards!.some((h) => dist(h, p) < 0.8)) s.health!--;
    }
    s.cores = s.cores!.filter((c) => !equal(c, s.drone!));
    s.score = 3 - s.cores.length;
    if (s.health! <= 0) {
      s.status = "lost";
      s.reason = "Drone damaged beyond repair";
    } else if (!s.cores.length && equal(s.drone!, { x: 0, y: 2, z: 0 })) {
      s.status = "won";
      s.reason = "All cores recovered; drone returned to beacon";
    } else if (s.tick >= 70) {
      s.status = "timeout";
      s.reason = "Oxygen reserve exhausted after 70 moves";
    }
  }
  return s;
}
export function greedy(s: State): string {
  const previews = observe(s).action_preview as Record<string, any>;
  return Object.keys(previews).sort((a, b) => {
    const cost = (p: any) =>
      (p.immediate_collision || p.out_of_bounds || p.hazard_collision
        ? 1000
        : 0) + (p.distance_to_food ?? p.distance_to_nearest_objective);
    return cost(previews[a]) - cost(previews[b]);
  })[0];
}
export function question(s: State) {
  return {
    type: "choice" as const,
    instructions: `Choose one action for this ${s.game === "snake" ? "Snake" : "3D drone rescue"} game. Collect ${s.game === "snake" ? "food while surviving. Think about your growing body and future escape space." : "all energy cores and return to the beacon. Avoid hazards and boundaries."} The game engine supplies immediate action previews, not a route plan. Do not invent actions. State: ${JSON.stringify(observe(s))}`,
    criteria: options(s),
  };
}
