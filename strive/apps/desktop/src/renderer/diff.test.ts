import { expect, test } from "bun:test";
import { type DiffRow, diffLines, drawn, hunks } from "./diff";

const rows = (before: string, after: string) => diffLines(before, after).map((r) => `${r.kind[0]} ${r.text}`);

test("unchanged lines are kept and a changed one is removed then added", () => {
  expect(rows("a\nb\nc\n", "a\nB\nc\n")).toEqual(["k a", "r b", "a B", "k c"]);
});

test("insertions and deletions keep the lines around them", () => {
  expect(rows("a\nc", "a\nb\nc")).toEqual(["k a", "a b", "k c"]);
  expect(rows("a\nb\nc", "a\nc")).toEqual(["k a", "r b", "k c"]);
});

test("a new file is all added", () => {
  expect(rows("", "x\ny")).toEqual(["a x", "a y"]);
});

test("a change deep in a long file shows with its context, and the unchanged runs fold", () => {
  const before = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 450", "LINE 450");
  const parts = hunks(diffLines(before, after));
  expect(parts.map((p) => [p.kind, p.rows.length])).toEqual([
    ["gap", 446],
    ["rows", 8],
    ["gap", 47],
  ]);
  const shown = parts[1]?.rows.map((r) => `${r.kind[0]} ${r.text}`);
  expect(shown).toEqual([
    "k line 447",
    "k line 448",
    "k line 449",
    "r line 450",
    "a LINE 450",
    "k line 451",
    "k line 452",
    "k line 453",
  ]);
});

test("changes close together share one hunk", () => {
  const before = "a\nb\nc\nd\ne\nf\ng";
  const parts = hunks(diffLines(before, before.replace("b", "B").replace("f", "F")), 1);
  expect(parts.map((p) => p.kind)).toEqual(["rows"]);
});

test("a hunk with more rows than a call takes arguments merges without throwing", () => {
  // Two long runs of changes around a gap too short to fold: the second is
  // merged into the first. (Past about a million, even Bun's engine refuses
  // that many arguments; Electron's refuses far fewer.)
  const run = 1_100_000;
  const rows: DiffRow[] = [];

  for (let n = 0; n < run; n++) rows.push({ kind: "add", text: "a", n });

  rows.push({ kind: "keep", text: "k", n: run }, { kind: "keep", text: "k", n: run + 1 });

  for (let n = run + 2; n < 2 * run + 2; n++) rows.push({ kind: "add", text: "b", n });

  const parts = hunks(rows, 0);
  expect(parts.map((p) => [p.kind, p.rows.length])).toEqual([["rows", 2 * run + 2]]);
});

test("opening the context before a change never hides the change", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
  const after = before.replace("line 2000\n", "LINE 2000\n");
  const parts = hunks(diffLines(before, after));
  const gap = parts[0];
  expect(gap?.kind).toBe("gap");
  const { items } = drawn(parts, new Set([gap?.rows[0]?.n ?? -1]), 2000);
  const texts = items.flatMap((i) => (i.kind === "row" ? [`${i.row.kind[0]} ${i.row.text}`] : []));
  expect(texts).toContain("a LINE 2000");
  expect(texts).toContain("r line 2000");
});
