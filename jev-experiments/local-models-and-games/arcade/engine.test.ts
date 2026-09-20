import { test, expect } from "bun:test";
import { initial, step, greedy } from "./engine";
test("Same seed and actions replay exactly", () => {
  for (const game of ["snake", "orbital"] as const) {
    let a = initial(game, 7),
      b = initial(game, 7);
    for (let i = 0; i < 60; i++) {
      a = step(a, greedy(a));
      b = step(b, greedy(b));
      expect(a).toEqual(b);
    }
  }
});
test("Snake permits a vacating tail cell but rejects other body collisions", () => {
  const s = initial("snake", 7);
  s.snake = [
    { x: 2, y: 2 },
    { x: 2, y: 3 },
    { x: 1, y: 3 },
    { x: 1, y: 2 },
  ];
  s.heading = 3;
  s.food = { x: 8, y: 8 };
  expect(step(s, "straight").status).toBe("playing");
  expect(step(s, "left").status).toBe("lost");
});
test("A rescued drone must return home, and terminal states do not advance", () => {
  const s = initial("orbital", 7);
  s.cores = [{ x: 1, y: 2, z: 0 }];
  s.hazards = [];
  const a = step(s, "east");
  expect(a.status).toBe("playing");
  const b = step(a, "west");
  expect(b.status).toBe("won");
  expect(step(b, "up")).toEqual(b);
});
