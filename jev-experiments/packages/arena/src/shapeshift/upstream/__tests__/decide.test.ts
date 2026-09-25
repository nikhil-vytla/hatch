import { describe, expect, test } from "bun:test";
import { changedSubstantially, decide, force, initialMemory, promote, rawState, type DecideMemory } from "../decide";
import { result } from "./helpers";

const run = (steps: [Parameters<typeof result>[0], string][], start: DecideMemory = initialMemory) => {
  const states: DecideMemory[] = [];
  let mem = start;
  for (const [p, text] of steps) {
    mem = decide(mem, result(p), text);
    states.push(mem);
  }
  return states;
};

describe("rawState thresholds", () => {
  test("none or low confidence → input", () => {
    expect(rawState(result({ none: 0.9 })).kind).toBe("input");
    expect(rawState(result({ event: 0.35, todo: 0.1 })).kind).toBe("input");
  });
  test("mid confidence → ghost", () => {
    expect(rawState(result({ event: 0.55, todo: 0.2 }))).toEqual({ kind: "ghost", intent: "event" });
  });
  test("high confidence → committed", () => {
    expect(rawState(result({ timer: 0.82 }))).toEqual({ kind: "committed", intent: "timer" });
  });
  test("close top two → choose", () => {
    expect(rawState(result({ event: 0.42, reminder: 0.36 }))).toEqual({ kind: "choose", options: ["event", "reminder"] });
  });
  test("close but one below floor → not choose", () => {
    expect(rawState(result({ event: 0.3, reminder: 0.2 })).kind).toBe("input");
  });
});

describe("hysteresis", () => {
  test("a single challenger blip does not switch a committed card", () => {
    const s = run([
      [{ event: 0.8 }, "dinner with priya friday"],
      [{ reminder: 0.72, event: 0.2 }, "dinner with priya friday 8"],
      [{ event: 0.78 }, "dinner with priya friday 8pm"],
    ]);
    expect(s.map((m) => m.ui)).toEqual([
      { kind: "committed", intent: "event" },
      { kind: "committed", intent: "event" },
      { kind: "committed", intent: "event" },
    ]);
  });

  test("challenger wins twice → switch", () => {
    const s = run([
      [{ event: 0.8 }, "call mom"],
      [{ reminder: 0.74, event: 0.2 }, "call mom remind"],
      [{ reminder: 0.76, event: 0.2 }, "call mom remind me"],
    ]);
    expect(s[1].ui).toEqual({ kind: "committed", intent: "event" });
    expect(s[2].ui).toEqual({ kind: "committed", intent: "reminder" });
  });

  test("strong challenger (≥0.85) switches immediately", () => {
    const s = run([
      [{ note: 0.75 }, "a warm sunset"],
      [{ color: 0.9 }, "a warm sunset orange"],
    ]);
    expect(s[1].ui).toEqual({ kind: "committed", intent: "color" });
  });

  test("alternating challengers never switch", () => {
    const s = run([
      [{ event: 0.8 }, "a"],
      [{ todo: 0.7, event: 0.2 }, "ab"],
      [{ reminder: 0.7, event: 0.2 }, "abc"],
      [{ todo: 0.7, event: 0.2 }, "abcd"],
      [{ reminder: 0.7, event: 0.2 }, "abcde"],
    ]);
    expect(s.every((m) => m.ui.kind === "committed" && m.ui.intent === "event")).toBe(true);
  });

  test("committed → input only below 0.30", () => {
    const s = run([
      [{ event: 0.8 }, "dinner friday"],
      [{ none: 0.5, event: 0.35 }, "dinner fr"],
      [{ none: 0.8, event: 0.1 }, "di"],
    ]);
    expect(s[1].ui.kind).toBe("committed");
    expect(s[2].ui.kind).toBe("input");
  });

  test("clearing text resets", () => {
    const s = run([
      [{ event: 0.8 }, "dinner friday"],
      [{ event: 0.8 }, ""],
    ]);
    expect(s[1].ui.kind).toBe("input");
  });

  test("ghost ↔ input flicker is driven purely by thresholds", () => {
    const s = run([
      [{ event: 0.45 }, "dinner"],
      [{ event: 0.5 }, "dinner w"],
      [{ event: 0.72 }, "dinner with"],
    ]);
    expect(s.map((m) => m.ui.kind)).toEqual(["ghost", "ghost", "committed"]);
  });
});

describe("forced intents", () => {
  test("stay locked through small edits, release on big ones", () => {
    let mem = force("poll", "pizza or burgers");
    mem = decide(mem, result({ note: 0.9 }), "pizza or burgers?");
    expect(mem.ui).toEqual({ kind: "committed", intent: "poll", forced: true });
    mem = decide(mem, result({ note: 0.9 }), "completely different text now");
    expect(mem.ui).toEqual({ kind: "committed", intent: "note" });
  });
  test("Levenshtein threshold at 30%", () => {
    expect(changedSubstantially("pizza or burgers", "pizza or burger")).toBe(false);
    expect(changedSubstantially("abc", "xyz")).toBe(true);
  });
  test("promote turns ghost into committed", () => {
    const mem = decide(initialMemory, result({ todo: 0.5 }), "milk, eggs");
    expect(promote(mem).ui).toEqual({ kind: "committed", intent: "todo" });
  });
});
