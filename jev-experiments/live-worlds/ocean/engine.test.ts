import { describe, expect, test } from "bun:test";
import type { ZeroShot } from "../../packages/arena/src/decide/nli";
import {
  advance,
  applyDecisions,
  createReef,
  due,
  fingerprint,
  STALE_AFTER,
  staleShare,
  trigger,
  view,
  type Decision,
  type World,
} from "./engine";
import { decideWithNli, fromJev, jevRequest } from "./models";

const run = (w: World, seconds: number) => {
  for (let i = 0; i < seconds * 30; i++) advance(w);
};

/** Decides every due fish each second with a fixed rule, so runs are reproducible. */
function rule(w: World): Decision[] {
  return due(w, 200).map((f) => {
    const v = view(w, f);
    const action = v.options.includes("flee") ? "flee" : v.energy !== "high" ? "forage" : "school";

    return { id: f.id, action, probabilities: null, by: "rule", latencyMs: 0 };
  });
}

describe("reef engine", () => {
  test("the same seed, events and decisions give the same reef", () => {
    const go = () => {
      const w = createReef(11);

      for (let s = 0; s < 40; s++) {
        if (s === 10) trigger(w, "heatwave");

        applyDecisions(w, rule(w));
        run(w, 1);
      }

      return fingerprint(w);
    };

    expect(go()).toBe(go());
  });

  test("fish that never eat starve", () => {
    const w = createReef(3, 20);

    w.sharks = [];
    w.food = [];
    for (const f of w.fish) {
      f.energy = 0.1;
      applyDecisions(w, [{ id: f.id, action: "rest", probabilities: null, by: "t", latencyMs: 0 }]);
    }

    // Plankton is cleared every step, so nobody can eat.
    for (let i = 0; i < 30 * 120; i++) {
      w.food = [];
      advance(w);
    }

    expect(w.fish.filter((f) => f.alive)).toHaveLength(0);
    expect(w.deaths.starved).toBeGreaterThan(0);
  });

  test("well-fed fish have young that inherit mutated traits", () => {
    const w = createReef(5, 30);

    w.sharks = [];
    run(w, 1);
    for (const f of w.fish) {
      f.energy = 1;
      f.age = 30;
    }
    advance(w);

    const child = w.fish.find((f) => f.parent !== null);

    expect(w.births).toBeGreaterThan(0);
    expect(child).toBeDefined();

    const parent = w.fish.find((f) => f.id === child?.parent);

    expect(child?.gen).toBe((parent?.gen ?? 0) + 1);
    expect(Math.abs((child?.traits.speed ?? 0) - (parent?.traits.speed ?? 0))).toBeLessThanOrEqual(0.08 + 1e-9);
  });

  test("a decision goes stale; the fish keeps its last action", () => {
    const w = createReef(9, 10);
    const f = w.fish[0];

    applyDecisions(w, [{ id: f.id, action: "rest", probabilities: null, by: "t", latencyMs: 0 }]);
    run(w, STALE_AFTER + 1);
    expect(f.action).toBe("rest");
    expect(w.time - f.decidedAt).toBeGreaterThan(STALE_AFTER);
    expect(staleShare(w)).toBe(1);
  });

  test("an action outside the fish's options is refused", () => {
    const w = createReef(9, 10);

    w.sharks = [];
    const f = w.fish[0];

    expect(view(w, f).options).not.toContain("flee");
    expect(applyDecisions(w, [{ id: f.id, action: "flee", probabilities: null, by: "t", latencyMs: 0 }])).toBe(0);
  });

  test("a heatwave bleaches coral and reports its cohort's survival", () => {
    const w = createReef(13);

    trigger(w, "heatwave");
    run(w, 36);
    expect(Math.max(...w.coral.map((c) => c.health))).toBeLessThan(0.35);
    expect(w.outcomes[0]?.kind).toBe("heatwave");
    expect(w.outcomes[0]?.cohort).toBeGreaterThan(0);
  });
});

describe("reef models", () => {
  test("Jev's request asks one choice per fish over its own options", () => {
    const w = createReef(2, 5);
    const views = w.fish.map((f) => view(w, f));
    const r = jevRequest(views);

    expect(Object.keys(r.questions)).toHaveLength(5);

    for (const v of views) expect(Object.keys(r.questions[`fish_${v.id}`].criteria)).toEqual(v.options);
  });

  test("Jev answers outside the options are dropped", () => {
    const w = createReef(2, 2);

    w.sharks = [];
    const views = w.fish.map((f) => view(w, f));
    const d = fromJev(views, { [`fish_${views[0].id}`]: { value: "forage" }, [`fish_${views[1].id}`]: { value: "flee" } }, 200);

    expect(d.map((x) => x.action)).toEqual(["forage"]);
  });

  test("the small model picks its highest-scoring option", async () => {
    const w = createReef(2, 1);
    const v = view(w, w.fish[0]);
    const fake: ZeroShot = async (_p, labels) => ({ labels, scores: labels.map((l) => (l.includes("eat") ? 0.9 : 0.01)) });

    expect((await decideWithNli(fake, v)).action).toBe("forage");
  });
});
