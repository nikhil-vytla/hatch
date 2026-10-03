/**
 * Eyes against state: the shared pieces of the pixels lane.
 *
 * A vision model sees the board image and picks an absolute direction (up, right, down, left).
 * The engine's actions are relative (left, straight, right), so the choice is translated with the
 * snake's heading, as a game pad's arrow keys would be. Choosing to go back the way it came would
 * drive the head into its own neck: that ends the game, the same as any collision.
 */
import { step, type State } from "../../local-models-and-games/arcade/engine";

/** The board's colours, shared by the PNG the model sees (frame.ts) and the page's canvas. */
export const PALETTE = {
  floor: [255, 244, 224],
  grid: [233, 220, 196],
  body: [47, 158, 110],
  head: [23, 20, 15],
  food: [240, 83, 45],
} as const;

export const DIRECTIONS = ["up", "right", "down", "left"] as const;

export type Direction = (typeof DIRECTIONS)[number];

/** Answer letters, one token each, in DIRECTIONS order. */
export const LABELS = ["A", "B", "C", "D"] as const;

export const QUESTION =
  "This is a Snake game on a 10 by 10 grid. The black square is the snake's head, the green squares are its body, and the red dot is food. Each step the head moves one cell; the snake dies if the head hits a wall or its own body. Which way should the head move next to reach the food safely?\nA: up\nB: right\nC: down\nD: left\nAnswer with one letter.";

/** A second wording, tried once to give the model a fairer chance; both runs are kept and reported. */
export const QUESTION_V2 =
  "Snake game, 10 by 10 grid. Black square: the snake's head. Green squares: its body, which trails behind the head, so the head is moving away from the green square it touches. Red dot: food. The head moves one cell per step; leaving the grid or touching green ends the game, and the head cannot move back onto its own body. Pick the move that takes the head one cell closer to the red dot without leaving the grid or touching green.\nA: up\nB: right\nC: down\nD: left\nAnswer with one letter.";

export const PROMPTS = { v1: QUESTION, v2: QUESTION_V2 } as const;

export type Relative = "left" | "straight" | "right" | "reverse";

/** Translate an absolute direction to the engine's action, given the true heading (0 up, 1 right, 2 down, 3 left). */
export function relative(heading: number, d: Direction): Relative {
  const turn = (DIRECTIONS.indexOf(d) - heading + 4) % 4;

  return turn === 0 ? "straight" : turn === 1 ? "right" : turn === 3 ? "left" : "reverse";
}

/** Apply a relative move; reversing into the neck ends the game. */
export function apply(s: State, move: Relative): State {
  if (move !== "reverse") return step(s, move);

  return { ...structuredClone(s), tick: s.tick + 1, status: "lost", reason: "Turned back into its own neck" };
}

/** The most probable direction (ties keep DIRECTIONS order). */
export function pick(p: Record<Direction, number>): Direction {
  return DIRECTIONS.reduce((best, d) => (p[d] > p[best] ? d : best), DIRECTIONS[0]);
}

export type FrameRecord = {
  seed: number;
  prompt: keyof typeof PROMPTS;
  tick: number;
  frame_sha256: string;
  model: string;
  server: string;
  probabilities: Record<Direction, number>;
  label_mass: number;
  ms: number;
  prompt_tokens: number;
  chosen: Direction;
  move: Relative;
  greedy: string;
  at: string;
};
