/**
 * The rumour mill's keyword rule for where a message invites people; shared by the page and the
 * free-model evaluation (packages/arena/scripts/free-model-evaluate.ts).
 */
import type { PlaceId } from "./town";

/** A notice that names a place lets residents go there. */
export function placeIn(text: string): PlaceId | null {
  const t = text.toLowerCase();
  const words: [PlaceId, string[]][] = [
    ["bakery", ["bakery", "baker"]],
    ["hall", ["town hall", "council", "mayor"]],
    ["market", ["market"]],
    ["bridge", ["bridge"]],
    ["stage", ["bandstand", "gig", "concert"]],
    ["library", ["library"]],
    ["school", ["school"]],
    ["pub", ["pub", "the crown"]],
  ];

  for (const [id, ws] of words) if (ws.some((w) => t.includes(w))) return id === "hall" && !/\b(come|meet|join|at the)\b/.test(t) ? null : id;

  return null;
}
