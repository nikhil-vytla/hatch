import { describe, expect, test } from "bun:test";
import { gateSignals, neutralGated } from "../signals";
import type { Answer, EventMode } from "../jev/types";
import { result } from "./helpers";

const mode = (value: EventMode, confidence: number): Answer<EventMode> => ({ value, confidence, probabilities: { [value]: confidence } });

describe("gateSignals", () => {
  test("only reads signals the intent uses", () => {
    const g = gateSignals(neutralGated, result({ event: 0.9 }, { eventMode: mode("video_call", 0.9), isShoppingList: 0.9 }), ["eventMode"]);
    expect(g.eventMode).toBe("video_call");
    expect(g.isShoppingList).toBe(false);
  });

  test("choice needs ≥0.60 and a non-escape value", () => {
    expect(gateSignals(neutralGated, result({}, { eventMode: mode("video_call", 0.55) }), ["eventMode"]).eventMode).toBeNull();
    expect(gateSignals(neutralGated, result({}, { eventMode: mode("unspecified", 0.95) }), ["eventMode"]).eventMode).toBeNull();
  });

  test("noul hysteresis band keeps badges from blinking", () => {
    const seq = [0.7, 0.6, 0.5, 0.62, 0.44, 0.55, 0.66];
    let g = neutralGated;
    const out: boolean[] = [];
    for (const p of seq) {
      g = gateSignals(g, result({}, { recurring: p }), ["recurring"]);
      out.push(g.recurring);
    }
    expect(out).toEqual([true, true, true, true, false, false, true]);
  });

  test("urgency adds caution edge only past 1.2, with hysteresis", () => {
    const u = (score: number) => result({}, { urgency: { score, confidence: 0.8 } });
    let g = gateSignals(neutralGated, u(1.1), ["urgency"]);
    expect(g.urgent).toBe(false);
    expect(g.urgency).toBeCloseTo(1.1);
    g = gateSignals(g, u(1.3), ["urgency"]);
    expect(g.urgent).toBe(true);
    g = gateSignals(g, u(1.1), ["urgency"]);
    expect(g.urgent).toBe(true);
    g = gateSignals(g, u(0.9), ["urgency"]);
    expect(g.urgent).toBe(false);
  });
});
