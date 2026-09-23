import { expect, test } from "bun:test";
import { grammarFor, tokens } from "./highlight";

test("a fence's language, or its alias, names a grammar; others don't", () => {
  expect(["ts", "rs", "sh", "yml", "Python"].map(grammarFor)).toEqual(["typescript", "rust", "bash", "yaml", "python"]);
  expect(grammarFor("brainfuck")).toBeUndefined();
});

test("code is split into coloured tokens, a keyword and a number in different colours", async () => {
  const lines = await tokens("const n = 42;\nlet s = 'x';", "ts");
  expect(lines?.length).toBe(2);
  const first = lines?.[0] ?? [];
  const colour = (text: string) => first.find((t) => t.content.includes(text))?.color;
  expect(colour("const")).toBeDefined();
  expect(colour("42")).toBeDefined();
  expect(colour("const")).not.toBe(colour("42"));
  expect(first.map((t) => t.content).join("")).toBe("const n = 42;");
});

test("a language strive has no grammar for is left plain", async () => {
  expect(await tokens("+++", "brainfuck")).toBeUndefined();
});
