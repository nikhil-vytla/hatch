import { describe, expect, test } from "bun:test";
import { advance, counts, createWorld, keyFor, pin, settled, simulate, Status, TICK, waitingProfiles } from "./engine";
import { allProfiles, jevRequest, toDist, type Dist } from "./profiles";
import { features, profileDist, type Vectors } from "./similarity";
import { PRESETS } from "./presets";
import { createTown } from "./town";
import vectors from "./vectors.json";

const town = createTown(7, 1200);

const all = (d: Dist) => new Map(allProfiles("rumour").map((p) => [p.key, d]));

const believers: Dist = { ignore: 0, share: 1, go: 0, argue: 0 };

const doubters: Dist = { ignore: 0, share: 0, go: 0, argue: 1 };

describe("rumour engine", () => {
  test("the town is deterministic from its seed, and everyone has a neighbour", () => {
    const again = createTown(7, 1200);

    expect(again.residents.map((r) => [r.x, r.archetype])).toEqual(town.residents.map((r) => [r.x, r.archetype]));
    expect(town.links.every((l) => l.length > 0)).toBe(true);
    expect(town.residents.filter((r) => r.hub)).toHaveLength(8);
  });

  test("a rumour everyone believes reaches most of town; one nobody believes stops at the noticeboard", () => {
    const spread = counts(simulate(town, "rumour", "x", null, 0, all(believers)));
    const stopped = counts(simulate(town, "rumour", "x", null, 0, all(doubters)));

    expect(spread.heard).toBeGreaterThan(town.residents.length * 0.9);
    expect(spread.believe).toBe(spread.heard);
    expect(stopped.heard).toBe(8);
    expect(stopped.argue).toBe(8);
  });

  test("the same seed and answers give the same spread", () => {
    const d: Dist = { ignore: 0.4, share: 0.4, go: 0, argue: 0.2 };
    const a = simulate(town, "rumour", "x", null, 3, all(d), 5);
    const b = simulate(town, "rumour", "x", null, 3, all(d), 5);

    expect(counts(a)).toEqual(counts(b));
    expect(a.curve).toEqual(b.curve);
  });

  test("residents wait for their profile's answer while the rest of town carries on", () => {
    const w = createWorld(town, 1);
    const t = pin(w, "rumour", "x", null, 0);

    advance(w, TICK * 3);
    expect(counts(w).thinking).toBe(8);

    const waiting = waitingProfiles(w, t);

    expect(waiting.length).toBeGreaterThan(0);

    for (const k of waiting) t.answers.set(k, believers);

    advance(w, TICK);
    expect(counts(w).believe).toBe(8);
    expect(settled(w)).toBe(false);
  });

  test("go only happens when the message names a place, and arrivals are counted after the walk", () => {
    const go: Dist = { ignore: 0, share: 0, go: 1, argue: 0 };
    const noPlace = counts(simulate(town, "rumour", "x", null, 0, all(go)));
    const bakery = simulate(town, "rumour", "x", "bakery", 0, all(go), 1, 80);

    expect(noPlace.going).toBe(0);
    expect(counts(bakery).going).toBe(counts(bakery).believe);
    expect(counts(bakery).arrived).toBe(counts(bakery).going);
  });

  test("a correction turns believers who accept it, and they stop passing the rumour on", () => {
    const w = createWorld(town, 1);
    const t = pin(w, "rumour", "x", null, 0);

    t.answers = all(believers);
    advance(w, TICK * 4);

    const c = pin(w, "counter", "not x", null, 0);

    c.answers = new Map(allProfiles("counter").map((p) => [p.key, believers]));

    while (!settled(w) && w.time < 80) advance(w, TICK);

    const final = counts(w);

    expect(final.corrected).toBeGreaterThan(0);
    expect(final.believe + final.corrected + final.thinking).toBe(final.heard);
  });

  test("a resident's profile key matches one of the profiles Jev is asked about", () => {
    const w = createWorld(town, 1);
    const t = pin(w, "rumour", "x", null, 0);
    const keys = new Set(allProfiles("rumour").map((p) => p.key));

    for (let i = 0; i < t.status.length; i++) if (t.status[i] !== Status.Unaware) expect(keys.has(keyFor(w, t, i))).toBe(true);
  });
});

describe("deciders", () => {
  test("Jev's request fits the gateway: at most 100 questions, choice criteria, no go without a place", () => {
    const req = jevRequest(allProfiles("rumour").slice(0, 100), "rumour", "x", null, null);

    expect(Object.keys(req.questions).length).toBeLessThanOrEqual(100);
    expect(Object.keys(req.questions.p0.criteria)).toEqual(["ignore", "share", "argue"]);
    expect(Object.keys(jevRequest(allProfiles("rumour").slice(0, 1), "rumour", "x", null, "bakery").questions.p0.criteria)).toContain("go");
    expect(JSON.stringify(req).length).toBeLessThan(100_000);
  });

  test("toDist normalises Jev's probabilities and rejects empty ones", () => {
    expect(toDist({ share: 0.6, argue: 0.2, ignore: 0.2 })).toEqual({ ignore: 0.2, share: 0.6, go: 0, argue: 0.2 });
    expect(toDist(null)).toBeNull();
    expect(toDist({ share: 0 })).toBeNull();
  });

  test("the free model's odds are distributions, and it reads the cake as an invitation for sweet tooths", () => {
    const cake = PRESETS[0];
    // SAFETY: vectors.json is written by scripts/rumour-vectors.ts in exactly the Vectors shape.
    const v = vectors as unknown as Vectors & { messages: Record<string, number[]> };
    const f = features(v.messages[cake.text], v);
    const dists = allProfiles("rumour").map((p) => [p, profileDist(f, p, "rumour", cake.place)] as const);

    for (const [, d] of dists) expect(d.ignore + d.share + d.go + d.argue).toBeCloseTo(1, 6);

    const goFor = (a: string) => dists.filter(([p]) => p.archetype === a).reduce((s, [, d]) => s + d.go, 0);

    expect(goFor("sweet")).toBeGreaterThan(goFor("sceptic"));
    expect(Math.max(...Object.values(f.interest))).toBe(f.interest.sweet);
  });
});
