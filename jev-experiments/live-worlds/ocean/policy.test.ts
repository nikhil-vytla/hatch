import { describe, expect, test } from "bun:test";
import { ACTIONS, createReef, view, type View } from "./engine";
import { evolved } from "./deciders";
import { fitness, runEpisode } from "./evaluate";
import { choose, decideAll, features, INPUTS, WEIGHT_COUNT } from "./policy";
import { ruleAction } from "./rule";
import { centredRanks, generation, initial, rng } from "./train";
import shipped from "./policy.json";

const calm: View = { id: 1, energy: "high", predator: null, food: 0, coral: null, neighbours: 3, signal: null, water: [], options: ["school", "forage", "rest"] };

describe("evolved reef policy", () => {
  test("features are INPUTS numbers in [0, 1]", () => {
    const w = createReef(3);
    const x = features(view(w, w.fish[0]));

    expect(x).toHaveLength(INPUTS);
    expect(x.every((n) => n >= 0 && n <= 1)).toBe(true);
  });

  test("it only ever picks an allowed action, and its display probabilities sum to 1", () => {
    const r = rng(9);

    for (let k = 0; k < 50; k++) {
      const p = { weights: Array.from({ length: WEIGHT_COUNT }, () => r.normal()) };
      const v: View = { ...calm, options: ACTIONS.filter(() => r.next() > 0.4).concat("rest") };
      const { action, probabilities } = choose(p, v);

      expect(v.options).toContain(action);
      expect(Object.values(probabilities).reduce((a, b) => a + (b ?? 0), 0)).toBeCloseTo(1, 6);
    }
  });

  test("the shipped weights load and decide for every live fish", () => {
    expect(shipped.weights).toHaveLength(WEIGHT_COUNT);

    const w = createReef(5);
    const ds = decideAll(w, shipped);

    expect(ds).toHaveLength(w.fish.filter((f) => f.alive).length);
  });

  test("a training generation is deterministic given its seed", async () => {
    // A cheap stand-in for episodes: score is how close the weights are to all-ones.
    const score = async (flat: number[]) => {
      const out: number[] = [];

      for (let i = 0; i < flat.length; i += WEIGHT_COUNT) out.push(-flat.slice(i, i + WEIGHT_COUNT).reduce((s, x) => s + (x - 1) ** 2, 0));

      return out;
    };
    const a = await generation(initial(1), 42, score);
    const b = await generation(initial(1), 42, score);

    expect(a.step.theta).toEqual(b.step.theta);
    // And it moves uphill on that score.
    expect((await score(a.step.theta))[0]).toBeGreaterThan((await score(initial(1).theta))[0]);
  });

  test("centred ranks ignore the scale of the scores", () => {
    expect(centredRanks([3, 1, 2])).toEqual(centredRanks([300, 1, 20]));
  });

  test("a held-out episode is reproducible from its seed", async () => {
    const ep = { seed: 5003, event: "heatwave" as const, eventAt: 15, seconds: 30, budget: Infinity, every: 3 };
    const go = () => runEpisode(ep, evolved(shipped));

    expect(await go()).toEqual(await go());
    expect(fitness(await go())).toBeGreaterThan(0);
  });

  test("the hand-written rule hides from sharks, flees otherwise, and eats when hungry", () => {
    expect(ruleAction(["school", "forage", "rest", "hide", "flee"], "high", true)).toBe("hide");
    expect(ruleAction(["school", "forage", "rest", "flee"], "high", true)).toBe("flee");
    expect(ruleAction(["school", "forage", "rest"], "low", false)).toBe("forage");
    expect(ruleAction(["school", "forage", "rest"], "high", false)).toBe("school");
  });
});
