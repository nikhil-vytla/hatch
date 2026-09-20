import { describe, expect, test } from "bun:test";
import { RECIPES, exportSvg, fitStroke, marks, point, resample, sampleStroke } from "./engine";
import { lexicalRank, parseRanking, requestFor } from "./model";

describe("original brush geometry", () => {
  test("all ten recipes replay deterministic finite geometry without changing source samples", () => {
    const stroke = sampleStroke(), frozen = JSON.stringify(stroke), outputs = new Set<string>();
    for (const r of RECIPES) {
      const first = marks(stroke, r.id), second = marks(JSON.parse(frozen), r.id);
      expect(first).toEqual(second); expect(first.length).toBeGreaterThan(5);
      expect(JSON.stringify(first)).not.toMatch(/NaN|Infinity|undefined/);
      expect(first.every(m => m.width > 0 && m.opacity >= 0 && m.opacity <= 1)).toBe(true);
      outputs.add(JSON.stringify(first));
    }
    expect(outputs.size).toBe(10); expect(JSON.stringify(stroke)).toBe(frozen);
  });
  test("texture sampling is invariant to event rate along the same straight path", () => {
    const sparse = [point(10, 20), point(110, 20)], dense = Array.from({ length: 21 }, (_, i) => point(10 + i * 5, 20));
    expect(resample(sparse)).toEqual(resample(dense));
    for (const r of RECIPES) expect(marks({ id: 1, seed: 20, recipeId: r.id, points: sparse })).toEqual(marks({ id: 1, seed: 20, recipeId: r.id, points: dense }));
  });
  test("changing the seed changes irregular geometry while repeat comparison shares seed", () => {
    const s = sampleStroke(); expect(marks(s, "graphite-dust")).not.toEqual(marks({ ...s, seed: s.seed + 1 }, "graphite-dust"));
    const fitted = fitStroke(s); expect(fitted.seed).toBe(s.seed); expect(fitted.points.every(p => p.x >= 0 && p.x <= 1000 && p.y >= 0 && p.y <= 640)).toBe(true);
  });
  test("tap, repeated points, bounds and unsafe export text are handled", () => {
    expect(marks({ id: 0, seed: 1, recipeId: "fern-script", points: [] })).toEqual([]);
    expect(marks({ id: 0, seed: 1, recipeId: "fern-script", points: [point(5, 5), point(5, 5)] }).length).toBe(1);
    expect(point(-10, 700, 2)).toEqual({ x: 0, y: 640, pressure: 1 });
    expect(() => point(NaN, 1)).toThrow();
    const svg = exportSvg([sampleStroke()], '<script>alert("x")</script>');
    expect(svg).not.toContain("<script>"); expect(svg).toContain("&lt;script&gt;"); expect(svg).toContain('viewBox="0 0 1000 640"');
  });
});
describe("description-only selection", () => {
  test("every request covers the same full recipe bank and contains no pixels or stroke samples", () => {
    const request = requestFor("a quiet blue fabric");
    expect(request.state.candidates).toEqual(RECIPES); expect(Object.keys(request.questions)).toHaveLength(10);
    expect(JSON.stringify(request)).not.toContain('"points"'); expect(request.state.evidence).toContain("No image");
    expect(() => requestFor("  ")).toThrow();
  });
  test("missing/invalid scores fail closed and ties preserve declared bank order", () => {
    const good = { answers: Object.fromEntries(RECIPES.map(r => [`fit_${r.id}`, { value: .5 }])) };
    expect(parseRanking(good).map(r => r.id)).toEqual(RECIPES.map(r => r.id));
    for (const value of [undefined, NaN, -1, 1.5, ".7"]) {
      const bad = structuredClone(good) as any; bad.answers["fit_indigo-loom"].value = value; expect(() => parseRanking(bad)).toThrow();
    }
    expect(() => parseRanking({ answers: {} })).toThrow();
  });
  test("lexical preview is a declared count with explicit zero-match ties", () => {
    expect(lexicalRank("quiet blue woven threads")[0].id).toBe("indigo-loom");
    expect(lexicalRank("golden pollen cloud")[0].id).toBe("pollen-cloud");
    expect(lexicalRank("zzqx").every(r => r.score === 0)).toBe(true);
    expect(lexicalRank("zzqx").map(r => r.id)).toEqual(RECIPES.map(r => r.id));
  });
});
