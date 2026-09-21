/** A deterministic, bounded cellular sandbox. No network or wall-clock state. */
export const VERSION = "materials-1";
export const WIDTH = 96,
  HEIGHT = 64;
export const MATERIALS = [
  { id: 1, name: "Sand", color: "#e6ba70", description: "Falls and piles up" },
  {
    id: 2,
    name: "Water",
    color: "#67b2dc",
    description: "Falls and spreads sideways",
  },
  {
    id: 3,
    name: "Stone",
    color: "#7c899a",
    description: "Stays where you paint",
  },
  { id: 4, name: "Wood", color: "#bc8060", description: "Burns beside fire" },
  {
    id: 5,
    name: "Fire",
    color: "#fa8657",
    description: "Burns wood, turns water to steam",
  },
  {
    id: 6,
    name: "Steam",
    color: "#c4dee2",
    description: "Rises and slowly disappears",
  },
] as const;
export type Material = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Motion = "solid" | "powder" | "liquid" | "gas";
export type Rule = {
  name: string;
  motion: Motion;
  contact: "none" | "water" | "fire" | "sand" | "wood";
  becomes: "sand" | "water" | "stone" | "wood" | "fire" | "steam";
  instruction: string;
  source: "manual" | "jev";
  evidence?: unknown;
};
export type Scene = {
  format: typeof VERSION;
  width: number;
  height: number;
  cells: number[];
  ages: number[];
  tick: number;
  seed: number;
  rule: Rule;
  label: string;
};
export const DEFAULT_RULE: Rule = {
  name: "Bloom dust",
  motion: "powder",
  contact: "water",
  becomes: "wood",
  instruction: "A powder that turns into wood when it touches water.",
  source: "manual",
};
export const PRESETS = ["terrarium", "waterfall", "empty"] as const;
const ids: Record<Rule["becomes"], Material> = {
  sand: 1,
  water: 2,
  stone: 3,
  wood: 4,
  fire: 5,
  steam: 6,
};
const contacts = { none: -1, water: 2, fire: 5, sand: 1, wood: 4 };
export function createScene(
  preset: (typeof PRESETS)[number] = "terrarium",
): Scene {
  const scene: Scene = {
    format: VERSION,
    width: WIDTH,
    height: HEIGHT,
    cells: Array(WIDTH * HEIGHT).fill(0),
    ages: Array(WIDTH * HEIGHT).fill(0),
    tick: 0,
    seed: 73,
    rule: structuredClone(DEFAULT_RULE),
    label: preset,
  };
  if (preset === "empty") return scene;
  for (let x = 0; x < WIDTH; x++) paint(scene, x, HEIGHT - 1, 3, 0);
  if (preset === "waterfall") {
    for (let x = 12; x < 70; x++)
      paint(scene, x, 20 + Math.floor(x / 16), 3, 0);
    for (let y = 2; y < 18; y++)
      for (let x = 15; x < 40; x++) paint(scene, x, y, 2, 0);
    for (let x = 65; x < 89; x++) paint(scene, x, 49, 4, 0);
  } else {
    for (let x = 10; x < 46; x++)
      for (let y = 48; y < 62; y++) paint(scene, x, y, 2, 0);
    for (let x = 8; x < 48; x++) paint(scene, x, 62, 3, 0);
    for (let y = 46; y < 62; y++) {
      paint(scene, 8, y, 3, 0);
      paint(scene, 47, y, 3, 0);
    }
    for (let x = 62; x < 89; x++)
      for (let y = 54; y < 63; y++)
        if (y > 54 + Math.abs(x - 75) / 2) paint(scene, x, y, 1, 0);
    for (let y = 38; y < 51; y++) paint(scene, 26, y, 7, 2);
    for (let x = 56; x < 80; x++) paint(scene, x, 30, 3, 0);
    for (let x = 61; x < 76; x++) paint(scene, x, 29, 4, 0);
  }
  return scene;
}
export function paint(
  scene: Scene,
  x: number,
  y: number,
  material: Material,
  radius = 2,
) {
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const xx = Math.round(x) + dx,
        yy = Math.round(y) + dy;
      if (xx < 0 || xx >= scene.width || yy < 0 || yy >= scene.height) continue;
      const i = yy * scene.width + xx;
      scene.cells[i] = material;
      scene.ages[i] = 0;
    }
}
export function paintLine(
  scene: Scene,
  from: { x: number; y: number },
  to: { x: number; y: number },
  material: Material,
  radius: number,
) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  for (let i = 0; i <= steps; i++) {
    const t = steps ? i / steps : 0;
    paint(
      scene,
      from.x + (to.x - from.x) * t,
      from.y + (to.y - from.y) * t,
      material,
      radius,
    );
  }
}
export function step(scene: Scene) {
  const { width: w, height: h, cells, ages } = scene,
    moved = new Uint8Array(cells.length);
  const at = (x: number, y: number) =>
    x >= 0 && x < w && y >= 0 && y < h ? y * w + x : -1;
  const random = () => {
    scene.seed ^= scene.seed << 13;
    scene.seed ^= scene.seed >>> 17;
    scene.seed ^= scene.seed << 5;
    scene.seed >>>= 0;
    return scene.seed / 4294967296;
  };
  const set = (i: number, value: number) => {
    cells[i] = value;
    ages[i] = 0;
    moved[i] = 1;
  };
  for (let y = h - 1; y >= 0; y--)
    for (let xx = 0; xx < w; xx++) {
      const x = scene.tick % 2 ? w - xx - 1 : xx,
        i = y * w + x,
        cell = cells[i];
      if (!cell || moved[i]) continue;
      ages[i]++;
      const adjacent = [
        at(x - 1, y),
        at(x + 1, y),
        at(x, y - 1),
        at(x, y + 1),
      ].filter((n) => n >= 0);
      if (
        cell === 7 &&
        scene.rule.contact !== "none" &&
        adjacent.some((n) => cells[n] === contacts[scene.rule.contact])
      ) {
        set(i, ids[scene.rule.becomes]);
        continue;
      }
      if (cell === 5) {
        for (const n of adjacent) {
          if (cells[n] === 2) {
            set(n, 6);
            set(i, 6);
          } else if (cells[n] === 4 && random() < 0.12) set(n, 5);
        }
        if (cells[i] !== 5) continue;
        if (ages[i] > 22 && random() < 0.09) {
          set(i, 0);
          continue;
        }
        continue;
      }
      if (cell === 6 && ages[i] > 65 && random() < 0.035) {
        set(i, 0);
        continue;
      }
      const motion: Motion =
        cell === 7
          ? scene.rule.motion
          : cell === 1
            ? "powder"
            : cell === 2
              ? "liquid"
              : cell === 6
                ? "gas"
                : "solid";
      if (motion === "solid") continue;
      const dy = motion === "gas" ? -1 : 1,
        direction = random() < 0.5 ? -1 : 1;
      const choices = [
        at(x, y + dy),
        at(x + direction, y + dy),
        at(x - direction, y + dy),
      ];
      if (motion === "liquid" || motion === "gas")
        choices.push(at(x + direction, y), at(x - direction, y));
      const dest = choices.find(
        (n) =>
          n >= 0 &&
          !moved[n] &&
          (cells[n] === 0 || (motion === "powder" && cells[n] === 2)),
      );
      if (dest !== undefined) {
        [cells[i], cells[dest]] = [cells[dest], cells[i]];
        [ages[i], ages[dest]] = [ages[dest], ages[i]];
        moved[i] = moved[dest] = 1;
      }
    }
  scene.tick++;
}
export function parseScene(value: unknown): Scene {
  if (!value || typeof value !== "object")
    throw new Error("Choose an exported materials scene JSON file.");
  const s = value as Scene;
  if (
    s.format !== VERSION ||
    s.width !== WIDTH ||
    s.height !== HEIGHT ||
    !Number.isSafeInteger(s.tick) ||
    s.tick < 0 ||
    !Number.isInteger(s.seed) ||
    s.seed < 1 ||
    s.seed > 4294967295
  )
    throw new Error("This scene uses an unsupported format or grid size.");
  if (
    !Array.isArray(s.cells) ||
    s.cells.length !== WIDTH * HEIGHT ||
    !s.cells.every((v) => Number.isInteger(v) && v >= 0 && v <= 7) ||
    !Array.isArray(s.ages) ||
    s.ages.length !== s.cells.length ||
    !s.ages.every((v) => Number.isSafeInteger(v) && v >= 0)
  )
    throw new Error("The scene contains invalid cells or ages.");
  const r = s.rule;
  if (
    !r ||
    typeof r.name !== "string" ||
    r.name.length > 50 ||
    typeof r.instruction !== "string" ||
    r.instruction.length > 600 ||
    !["solid", "powder", "liquid", "gas"].includes(r.motion) ||
    !Object.hasOwn(contacts, r.contact) ||
    !Object.hasOwn(ids, r.becomes) ||
    !["manual", "jev"].includes(r.source) ||
    typeof s.label !== "string" ||
    s.label.length > 100
  )
    throw new Error("The scene contains an unsupported material rule.");
  return structuredClone(s);
}
export function ruleRequest(instruction: string) {
  return {
    state: {
      task: "Map the user's material instruction to these exact available controls. Do not invent a simulation rule. If the instruction asks for unsupported behavior, report unsupported.",
      instruction,
      limits:
        "One motion and at most one adjacent-contact transformation. Transform only the custom particle, not its neighbor. No temperature, density, timers, duplication, attraction or arbitrary code. Ignore color and name requests.",
    },
    questions: {
      support: {
        type: "choice",
        instructions:
          "Can the available controls exactly represent the requested behavior?",
        criteria: {
          supported: "Representable",
          unsupported:
            "Requires unavailable behavior or ambiguous requirements",
        },
      },
      motion: {
        type: "choice",
        instructions: "Choose its movement. Default to solid when unspecified.",
        criteria: {
          solid: "Stays in place",
          powder: "Falls and piles",
          liquid: "Falls and spreads sideways",
          gas: "Rises and spreads sideways",
        },
      },
      contact: {
        type: "choice",
        instructions:
          "Choose the adjacent material that triggers transformation, or none.",
        criteria: {
          none: "No reaction",
          water: "Water",
          fire: "Fire",
          sand: "Sand",
          wood: "Wood",
        },
      },
      becomes: {
        type: "choice",
        instructions:
          "Choose the transformation product. Choose stone when no reaction is requested; the product is then unused.",
        criteria: {
          sand: "Sand",
          water: "Water",
          stone: "Stone",
          wood: "Wood",
          fire: "Fire",
          steam: "Steam",
        },
      },
    },
  };
}
export function ruleFromAnswers(
  answers: Record<string, { value: unknown }>,
  instruction: string,
): Rule {
  if (answers.support?.value === "unsupported")
    throw new Error(
      "That instruction needs a behavior this sandbox does not support. Use one motion and one contact reaction.",
    );
  if (
    answers.support?.value !== "supported" ||
    !["solid", "powder", "liquid", "gas"].includes(
      String(answers.motion?.value),
    ) ||
    !Object.hasOwn(contacts, String(answers.contact?.value)) ||
    !Object.hasOwn(ids, String(answers.becomes?.value))
  )
    throw new Error(
      "The returned rule was incomplete or invalid. Your current material is unchanged.",
    );
  return {
    name: "Your material",
    motion: answers.motion.value as Motion,
    contact: answers.contact.value as Rule["contact"],
    becomes: answers.becomes.value as Rule["becomes"],
    instruction,
    source: "jev",
  };
}
/** Invalidate pending model work on any scene edit or navigation. */
export class Revision {
  value = 0;
  next() {
    return ++this.value;
  }
  valid(token: number) {
    return token === this.value;
  }
}
