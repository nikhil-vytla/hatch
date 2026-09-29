import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { splitRewardBench } from "./benchmark-publication";
import { gzipPublished, gzipRules } from "./gzip-published";

const rules = gzipRules(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));

describe("gzip-published", () => {
  test("vercel.json gzips the research data and nothing else", () => {
    const hit = (url: string) => rules.some((r) => r.test(url));

    expect(hit("/data/judge.json")).toBe(true);
    expect(hit("/judgment-reliability/cases/12-abcdef012345.json")).toBe(true);
    expect(hit("/visual-search/evidence.jsonl")).toBe(true);
    expect(hit("/rewardbench2/cases/Focus-40-a0983cb630b7.json")).toBe(true);
    expect(hit("/icon-studio/LICENSE.txt")).toBe(false);
    expect(hit("/assets/index-abc.js")).toBe(false);
    expect(hit("/decide/decide.json")).toBe(true);
    expect(hit("/arena/index.json")).toBe(true);
    expect(hit("/capability-build.json")).toBe(false);
  });

  test("compresses matching files in place, once", () => {
    const dist = mkdtempSync(join(tmpdir(), "gz-"));
    const body = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, text: "same text again" })) });

    mkdirSync(join(dist, "data"));
    writeFileSync(join(dist, "data", "x.json"), body);
    writeFileSync(join(dist, "keep.json"), body);

    expect(gzipPublished(dist, rules).files).toBe(1);
    expect(gunzipSync(readFileSync(join(dist, "data", "x.json"))).toString()).toBe(body);
    expect(readFileSync(join(dist, "keep.json"), "utf8")).toBe(body);
    // A second pass leaves an already gzipped file alone.
    expect(gzipPublished(dist, rules).files).toBe(0);
  });
});

describe("splitRewardBench", () => {
  test("moves candidate texts to per-case files and keeps everything else", () => {
    const doc = {
      manifest: { m: 1 },
      result: {
        metrics: { a: 1 },
        rows: [
          { id: 7, subset: "Precise IF", prompt: "p", candidates: [{ label: "A", text: "one", score: 3 }, { label: "B", text: "two", score: 5 }] },
          { id: 8, subset: "Math", status: "failed" },
        ],
      },
    };

    const { index, cases } = splitRewardBench(doc);
    const [row, failed] = (index.result as { rows: Record<string, unknown>[] }).rows;

    expect(cases).toHaveLength(1);
    expect(row.case_file).toBe(cases[0].name);
    expect(cases[0].name).toMatch(/^Precise-IF-7-[0-9a-f]{12}\.json$/);
    expect(JSON.parse(cases[0].body)).toEqual({ texts: ["one", "two"] });
    expect(row.candidates).toEqual([{ label: "A", score: 3 }, { label: "B", score: 5 }]);
    expect(failed).toEqual({ id: 8, subset: "Math", status: "failed" });
    expect(index.manifest).toEqual({ m: 1 });
    expect(doc.result.rows[0].candidates?.[0].text).toBe("one");
  });
});
