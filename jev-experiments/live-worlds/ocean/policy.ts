/**
 * The reef's free decider: a tiny policy evolved inside this simulation. A fish's view becomes
 * 17 numbers; a two-layer network scores the seven actions; the best allowed action wins.
 *
 * It was trained only on survival in this reef (see train.ts). It never saw a Jev answer: the
 * recorded Jev run is used on the page as a comparison, not as a target, because TypeSafe's terms
 * forbid training a model to imitate Jev's output.
 *
 * Arithmetic only (no Math.tanh or exp in the decision), so every JavaScript engine decides alike.
 */
import { ACTIONS, view, type Action, type Decision, type Fish, type View, type World } from "./engine";

export const POLICY_NAME = "Evolved policy";
export const INPUTS = 17;
export const HIDDEN = 10;
export const OUTPUTS = ACTIONS.length;
/** Weights: input→hidden (with bias), hidden→output (with bias). */
export const WEIGHT_COUNT = (INPUTS + 1) * HIDDEN + (HIDDEN + 1) * OUTPUTS;

export type Policy = { weights: number[] };

const near = { "very close": 3, close: 2, far: 1 } as const;

/** The view as numbers, each in [0, 1]. */
export function features(v: View): number[] {
  const d = v.predator ? near[v.predator.distance] : 0;
  const water = v.water.join(" ");

  return [
    v.energy === "low" ? 1 : 0,
    v.energy === "medium" ? 1 : 0,
    v.energy === "high" ? 1 : 0,
    d === 1 ? 1 : 0,
    d === 2 ? 1 : 0,
    d === 3 ? 1 : 0,
    Math.min(v.food, 8) / 8,
    v.coral === "healthy" ? 1 : 0,
    v.coral === "bleached" ? 1 : 0,
    Math.min(v.neighbours, 10) / 10,
    v.signal === "danger" ? 1 : 0,
    v.signal === "food" ? 1 : 0,
    water.includes("hot") ? 1 : 0,
    water.includes("storm") ? 1 : 0,
    water.includes("net") ? 1 : 0,
    water.includes("oil") ? 1 : 0,
    1,
  ];
}

const softsign = (x: number) => x / (1 + Math.abs(x));

/** Action scores for a view (higher is better), before masking. */
export function scores(p: Policy, x: number[]): number[] {
  const w = p.weights;
  const h: number[] = [];

  for (let j = 0; j < HIDDEN; j++) {
    let s = w[INPUTS * HIDDEN + j];

    for (let i = 0; i < INPUTS; i++) s += x[i] * w[i * HIDDEN + j];

    h.push(softsign(s));
  }

  const o = (INPUTS + 1) * HIDDEN;
  const out: number[] = [];

  for (let k = 0; k < OUTPUTS; k++) {
    let s = w[o + HIDDEN * OUTPUTS + k];

    for (let j = 0; j < HIDDEN; j++) s += h[j] * w[o + j * OUTPUTS + k];

    out.push(s);
  }

  return out;
}

/** The best allowed action, plus a softmax over the allowed ones for display. */
export function choose(p: Policy, v: View): { action: Action; probabilities: Partial<Record<Action, number>> } {
  const s = scores(p, features(v));
  // An action listed twice must not count twice in the display probabilities.
  const options = [...new Set(v.options)];
  let best: Action = options[0];
  let top = -Infinity;

  for (const a of options) {
    const score = s[ACTIONS.indexOf(a)];

    if (score > top) {
      top = score;
      best = a;
    }
  }

  // Display only: the decision above doesn't depend on exp.
  const e = options.map((a) => Math.exp(s[ACTIONS.indexOf(a)] - top));
  const z = e.reduce((a, b) => a + b, 0);

  return { action: best, probabilities: Object.fromEntries(options.map((a, i) => [a, e[i] / z])) };
}

/** Decisions for the given fish (all of them if none given), one per fish, now. */
export function decideAll(w: World, p: Policy, fish: Fish[] = w.fish.filter((f) => f.alive)): Decision[] {
  return fish.map((f) => {
    const { action, probabilities } = choose(p, view(w, f));

    return { id: f.id, action, probabilities, by: POLICY_NAME, latencyMs: null };
  });
}
