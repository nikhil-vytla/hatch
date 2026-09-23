import { expect, test } from "bun:test";
import { diffLines } from "./diff";

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
