import { describe, expect, test } from "bun:test";
import { advanceGame, cells, chooseLanding, cloneGame, command, createGame, fits, ghost, landings, moved, PIECES, ROWS } from "./engine";

describe("complete deterministic game", () => {
  test("seeded seven-bag, RNG and queue survive cloning", () => {
    const a = createGame(42), b = cloneGame(a);
    expect(new Set([a.active.type, ...a.queue.slice(0, 6)]).size).toBe(7);
    for (let i = 0; i < 12; i++) {
      const pick = chooseLanding(landings(a))!;
      for (const input of pick.path) { command(a, input); command(b, input); }
      expect(a).toEqual(b);
    }
    expect(a.pieces).toBe(12);
    expect(a.status).toBe("playing");
  });
  test("gravity moves a piece and locks without any controller", () => {
    const g = createGame();
    const initialY = g.active.y;
    for (let i = 0; i < 45; i++) advanceGame(g, 20);
    expect(g.active.y).toBe(initialY + 1);
    for (let i = 0; i < 1000; i++) advanceGame(g, 20);
    expect(g.pieces).toBeGreaterThan(0);
    expect(g.board.flat().filter(Boolean).length).toBeGreaterThan(0);
  });
  test("four-line clear scores, advances level and removes occupied rows", () => {
    const g = createGame(); g.lines = 9;
    for (let y = 16; y < 20; y++) g.board[y] = Array.from({ length: 10 }, (_, x) => x === 4 ? 0 : 2);
    g.active = { type: "I", x: 2, y: 15, rotation: 1 };
    expect(cells(ghost(g)).map(([x]) => x)).toEqual([4, 4, 4, 4]);
    command(g, "drop");
    expect(g.lastClear).toBe(4); expect(g.lines).toBe(13); expect(g.level).toBe(2);
    expect(g.score).toBe(802); expect(g.board.flat().every(v => v === 0)).toBe(true);
  });
  test("rotation and kick poses remain collision-free at boundaries", () => {
    for (const type of PIECES) {
      const g = createGame(); g.active.type = type;
      for (let i = 0; i < 15; i++) command(g, "left");
      for (let i = 0; i < 12; i++) { command(g, i % 2 ? "cw" : "ccw"); expect(fits(g.board, g.active)).toBe(true); }
      for (let i = 0; i < 15; i++) command(g, "right");
      expect(cells(g.active).every(([x]) => x >= 0 && x < 10)).toBe(true);
    }
  });
  test("hold is once per piece and top-out is a real terminal state", () => {
    const g = createGame(); const type = g.active.type;
    command(g, "hold"); expect(g.held).toBe(type); const after = cloneGame(g);
    command(g, "hold"); expect(g).toEqual(after);
    command(g, "drop"); expect(g.canHold).toBe(true);
    const dead = createGame(); dead.board = Array.from({ length: ROWS }, () => Array(10).fill(1));
    command(dead, "drop"); expect(dead.status).toBe("over");
    const stopped = cloneGame(dead); command(dead, "left"); advanceGame(dead, 2000); expect(dead).toEqual(stopped);
  });
  test("every advertised landing route really reaches its computed result", () => {
    const g = createGame(73);
    g.board[19] = [1, 1, 0, 0, 0, 1, 1, 0, 0, 0];
    g.board[18] = [0, 1, 0, 0, 0, 0, 1, 0, 0, 0];
    for (const landing of landings(g)) {
      const copy = cloneGame(g), beforeLines = copy.lines;
      for (const action of landing.path) command(copy, action);
      expect(copy.lines - beforeLines).toBe(landing.features.lines);
      expect(copy.status === "over").toBe(landing.features.topOut);
      expect(copy.pieces).toBe(landing.features.topOut && landing.pose.y < 0 ? 0 : 1);
    }
  });
  test("grounded movement cannot reset locking forever", () => {
    const g = createGame(); g.active = ghost(g);
    for (let i = 0; i < 80 && g.pieceId === 1; i++) { command(g, i % 2 ? "left" : "right"); advanceGame(g, 100); }
    expect(g.pieceId).toBeGreaterThan(1);
    expect(moved(g.board, g.active, "soft")).not.toBeNull();
  });
});
