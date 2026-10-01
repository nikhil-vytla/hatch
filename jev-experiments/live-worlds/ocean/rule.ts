/**
 * A hand-written baseline: hide in healthy coral from a shark if possible, otherwise flee from
 * danger; eat when not full; otherwise school.
 */
import { view, type Action, type Decision, type Fish, type World } from "./engine";

export const RULE_NAME = "Hand-written rule";

export function ruleAction(options: Action[], energy: string, danger: boolean): Action {
  if (danger && options.includes("hide")) return "hide";

  if (options.includes("flee")) return "flee";

  if (energy !== "high") return "forage";

  return "school";
}

export function ruleDecisions(w: World, fish: Fish[]): Decision[] {
  return fish.map((f) => {
    const v = view(w, f);

    return { id: f.id, action: ruleAction(v.options, v.energy, v.predator !== null), probabilities: null, by: RULE_NAME, latencyMs: null };
  });
}
