import { expect, test } from "bun:test";
import type { McpTool } from "@strive/protocol";
import { mcpToolNames } from "./host";

const tool = (server: string, name: string): McpTool => ({ server, name, description: "", inputSchema: {} });

test("MCP tool names are what providers accept", () => {
  const [name] = mcpToolNames([tool("fs", "read file")]);
  expect(name).toBe("mcp__fs__read_file");
});

test("tools whose names would collide once cleaned up stay distinct", () => {
  const names = mcpToolNames([tool("s", "a.b"), tool("s", "a_b"), tool("s", "c")]);
  expect(new Set(names).size).toBe(3);
  expect(names[2]).toBe("mcp__s__c");

  for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
});

test("a hashed name can't land on another tool's own name", () => {
  const [first] = mcpToolNames([tool("s", "a.b"), tool("s", "a_b")]);
  const hashed = first?.replace("mcp__s__", "") ?? "";
  const names = mcpToolNames([tool("s", "a.b"), tool("s", "a_b"), tool("s", hashed)]);
  expect(new Set(names).size).toBe(3);
});

test("long names that share their first 64 characters stay distinct", () => {
  const long = "x".repeat(70);
  const names = mcpToolNames([tool("s", `${long}1`), tool("s", `${long}2`)]);
  expect(names[0]).not.toBe(names[1]);

  for (const n of names) expect(n.length).toBeLessThanOrEqual(64);
});
