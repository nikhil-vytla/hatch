import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cells, createGame, landings } from "../../../../live-worlds/tetris/engine";
import bankJson from "./bank.json";
import { buildDaily } from "./build-daily";
import { dailySchema, jevPick, pickDaily, SURE_AT } from "./daily";
import { distanceLevel, gridItem, gridTruth, solve } from "./grid";
import { bankSchema, dailySet } from "./items";
import { landingFacts, tetrisItem } from "./tetris";

describe("grid truth", () => {
  test("a door blocks until the key is picked up", () => {
    const rows = ["#######", "#A.K#E#", "#...D.#", "#######"];

    const t = gridTruth(rows);

    // A→K (2), down beside the door (2), through D with the key (1), up to E (1).
    expect(t.reachable).toBe(true);
    expect(t.needsKey).toBe(true);
    expect(t.exitSteps).toBe(6);
    expect(t.firstStepToKey).toBe("right");
  });

  test("no route means unreachable, and the key question does not apply", () => {
    const rows = ["#######", "#A.#.E#", "#K.#..#", "#######"];
    const t = gridTruth(rows);

    expect(t.reachable).toBe(false);
    expect(t.needsKey).toBe(null);
    expect(distanceLevel(t.exitSteps)).toBe(2);
  });

  test("two equally short first steps mean no unique first step", () => {
    const rows = ["#####", "#A..#", "#..K#", "#E..#", "#####"];

    expect(solve(rows, { x: 1, y: 1 }, { x: 3, y: 2 }).firstMoves.sort()).toEqual([
      "down",
      "right",
    ]);
    expect(gridTruth(rows).firstStepToKey).toBe(null);
  });
});

describe("tetris truth", () => {
  test("a landing that fills the bottom row completes it and clears a line", () => {
    const g = createGame(3);

    g.board = g.board.map((row, y) => (y === 19 ? row.map((_, x) => (x < 6 ? 1 : 0)) : row));
    g.active = { type: "I", x: 3, y: -1, rotation: 0 };
    const before = g.board.map((r) => [...r]);

    // A flat I in the four empty cells on the right of the bottom row.
    const filler = landings(g).find((l) => cells(l.pose).every(([x, y]) => y === 19 && x >= 6));

    if (!filler) throw new Error("expected a flat I landing at the right of the bottom row");

    expect(landingFacts(before, filler)).toMatchObject({ completes: true, lines: 1, holes: 0 });
  });
});

describe("generation", () => {
  test("is deterministic", () => {
    expect(tetrisItem(6)).toEqual(tetrisItem(6));
    expect(gridItem(3)).toEqual(gridItem(3));
  });

  test("the bank parses, has 150 of each kind, and every answer is one of its question's options", () => {
    const bank = bankSchema.parse(bankJson);

    expect(bank.items.filter((i) => i.kind === "tetris")).toHaveLength(150);
    expect(bank.items.filter((i) => i.kind === "grid")).toHaveLength(150);

    for (const item of bank.items)
      for (const [id, q] of Object.entries(item.questions)) {
        const t = item.truth[id];

        if (q.type === "choice") expect(Object.keys(q.criteria)).toContain(String(t));
        else if (q.type === "noul") expect([true, false]).toContain(t);
        else expect([0, 1, 2]).toContain(Number(t));
      }
  });

  test("a daily set is five fixed items, three Tetris and two grid", () => {
    const bank = bankSchema.parse(bankJson);
    const a = dailySet(bank, "2026-10-01");

    expect(a).toEqual(dailySet(bank, "2026-10-01"));
    expect(a).toHaveLength(5);
    expect(a.filter((id) => id.startsWith("tetris-"))).toHaveLength(3);
    expect(new Set(a).size).toBe(5);
    expect(dailySet(bank, "2026-10-02")).not.toEqual(a);
  });

  test("a Daily is four hesitant puzzles, one per kind, and one sure one", () => {
    const out = mkdtempSync(join(tmpdir(), "daily-"));

    buildDaily(join(import.meta.dir, "../.."), out);
    const { items } = dailySchema.parse(JSON.parse(readFileSync(join(out, "daily.json"), "utf8")));
    const byId = new Map(items.map((i) => [i.id, i]));
    const day = pickDaily(items, "2026-10-01").flatMap((id) => byId.get(id) ?? []);

    expect(pickDaily(items, "2026-10-01")).toEqual(day.map((i) => i.id));
    expect(day).toHaveLength(5);
    expect(new Set(day.map((i) => i.id)).size).toBe(5);
    expect(
      day
        .filter((i) => jevPick(i).p < SURE_AT)
        .map((i) => i.kind)
        .sort(),
    ).toEqual(["order", "phrase", "route", "tetris"]);
    expect(jevPick(day[2]).p).toBeGreaterThanOrEqual(SURE_AT);
    expect(pickDaily(items, "2026-10-02")).not.toEqual(day.map((i) => i.id));
  });
});
