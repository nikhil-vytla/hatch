import { describe, expect, test } from "bun:test";
import {
  createScene,
  paint,
  paintLine,
  parseScene,
  step,
  Revision,
  ruleFromAnswers,
  WIDTH,
} from "./engine";
describe("material simulation", () => {
  test("same exported state produces the same next 100 ticks", () => {
    const a = createScene(),
      b = parseScene(JSON.parse(JSON.stringify(a)));
    for (let i = 0; i < 100; i++) {
      step(a);
      step(b);
    }
    expect(a).toEqual(b);
  });
  test("sand falls, stone stays, water spreads and gas rises", () => {
    for (const [material, moves] of [
      [1, 1],
      [2, 1],
      [3, 0],
      [6, -1],
    ] as const) {
      const s = createScene("empty");
      paint(s, 20, 20, material, 0);
      step(s);
      expect(s.cells[(20 + moves) * WIDTH + 20]).toBe(material);
    }
  });
  test("one contact rule transforms only the custom particle", () => {
    const s = createScene("empty");
    paint(s, 20, 20, 7, 0);
    paint(s, 21, 20, 2, 0);
    paint(s, 21, 21, 3, 0);
    paint(s, 20, 21, 3, 0);
    paint(s, 22, 21, 3, 0);
    paint(s, 22, 20, 3, 0);
    s.tick = 1;
    step(s);
    expect(s.cells[20 * WIDTH + 20]).toBe(4);
    expect(s.cells[20 * WIDTH + 21]).toBe(2);
  });
  test("paint strokes connect and clip at boundaries", () => {
    const s = createScene("empty");
    paintLine(s, { x: 0, y: 2 }, { x: 20, y: 2 }, 3, 0);
    expect(s.cells.filter((v) => v === 3)).toHaveLength(21);
    paint(s, 0, 0, 2, 7);
    expect(s.cells).toHaveLength(96 * 64);
    expect(Object.keys(s.cells).length).toBe(s.cells.length);
  });
  test("import rejects unsupported grids, corrupt rules and nonfinite cells", () => {
    for (const corrupt of [
      { width: 2000 },
      { cells: [NaN] },
      { seed: 0 },
      { rule: { motion: "script" } },
    ])
      expect(() => parseScene({ ...createScene(), ...corrupt })).toThrow();
  });
  test("branch copies do not share grid or rule state", () => {
    const a = createScene(),
      b = parseScene(a);
    paint(b, 0, 0, 5, 1);
    b.rule.motion = "gas";
    expect(a.cells[0]).toBe(0);
    expect(a.rule.motion).toBe("powder");
  });
});
describe("interpretation safety", () => {
  test("invalid and unsupported replies never become rules", () => {
    expect(() => ruleFromAnswers({}, "anything")).toThrow();
    expect(() =>
      ruleFromAnswers({ support: { value: "unsupported" } }, "clone particles"),
    ).toThrow("does not support");
  });
  test("edits invalidate a delayed request token", async () => {
    const revision = new Revision(),
      token = revision.next();
    const reply = Promise.resolve({ token });
    revision.next();
    expect(revision.valid((await reply).token)).toBe(false);
  });
});
