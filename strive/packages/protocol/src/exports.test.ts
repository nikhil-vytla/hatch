import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Every type generated from the Rust protocol must be importable from @strive/protocol. */
test("the package exports every generated protocol type", () => {
  const dir = join(import.meta.dir, "generated");
  const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
  const missing = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3))
    .filter((name) => !index.includes(`"./generated/${name}"`));
  expect(missing).toEqual([]);
});
