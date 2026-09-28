import { expect, test } from "bun:test";
import { parseBlocks, parseInline } from "./markdown";

test("text inside a code fence is kept as written", () => {
  const blocks = parseBlocks("Before\n\n```ts\nconst a = **b**;\n- not a list\n```\nAfter");

  expect(blocks).toEqual([
    { kind: "paragraph", inline: [{ kind: "text", text: "Before" }] },
    { kind: "code", lang: "ts", text: "const a = **b**;\n- not a list" },
    { kind: "paragraph", inline: [{ kind: "text", text: "After" }] },
  ]);
});

test("an unclosed fence runs to the end, as while a reply streams", () => {
  expect(parseBlocks("```\nlet x = 1;")).toEqual([{ kind: "code", lang: "", text: "let x = 1;" }]);
});

test("list items stay together and a list ends a paragraph", () => {
  const blocks = parseBlocks("Two things:\n- one\n- `two`\n\n1. first\n2. second");

  expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "list", "list"]);
  expect(blocks[1]).toEqual({
    kind: "list",
    ordered: false,
    items: [[{ kind: "text", text: "one" }], [{ kind: "code", text: "two" }]],
  });
  expect(blocks[2]?.kind === "list" && blocks[2].ordered).toBe(true);
});

test("emphasis marks inside inline code aren't emphasis", () => {
  expect(parseInline("see `a **b** c` and **d**")).toEqual([
    { kind: "text", text: "see " },
    { kind: "code", text: "a **b** c" },
    { kind: "text", text: " and " },
    { kind: "strong", children: [{ kind: "text", text: "d" }] },
  ]);
});

test("underscores inside words aren't emphasis", () => {
  expect(parseInline("snake_case_name and _this_")).toEqual([
    { kind: "text", text: "snake_case_name and " },
    { kind: "em", children: [{ kind: "text", text: "this" }] },
  ]);
});

test("links keep their target", () => {
  expect(parseInline("[the docs](https://example.com/x)")).toEqual([
    { kind: "link", href: "https://example.com/x", children: [{ kind: "text", text: "the docs" }] },
  ]);
});
