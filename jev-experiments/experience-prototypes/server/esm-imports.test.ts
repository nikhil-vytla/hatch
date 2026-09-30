import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/**
 * Vercel runs the API functions under Node's ES-module loader, which needs explicit `.js`
 * extensions on relative imports; Bun (dev server, tests) resolves extensionless ones, so a
 * missing extension passes locally and crashes every call in production. This walks each
 * function's import graph and fails on an extensionless runtime import.
 */
const root = join(import.meta.dir, "..");
const entries = ["api/evaluate.ts", "api/compose.ts", "api/wardrobe-token.ts", "api/tally.ts", "api/route.ts"];

const specifier = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](\.{1,2}\/[^"']+)["']/gm;

test("every relative runtime import reachable from an API function has a .js extension", () => {
  const seen = new Set<string>();
  const missing: string[] = [];
  const todo = entries.map((e) => join(root, e));

  while (todo.length) {
    const file = todo.pop() as string;

    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    for (const [, spec] of readFileSync(file, "utf8").matchAll(specifier)) {
      const base = normalize(join(dirname(file), spec));

      if (!spec.endsWith(".js")) missing.push(`${file.replace(root, "")} → ${spec}`);

      const ts = spec.endsWith(".js") ? `${base.slice(0, -3)}.ts` : `${base}.ts`;

      if (existsSync(ts)) todo.push(ts);
    }
  }

  expect(seen.size).toBeGreaterThan(entries.length);
  expect(missing).toEqual([]);
});
