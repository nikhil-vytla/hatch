import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeFailure } from "./live-failure";

const SRC = import.meta.dir;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);

    if (e.isDirectory()) return sources(p);

    return /\.tsx$/.test(e.name) ? [p] : [];
  });
}

/** Every `<LiveFailure ... />` element in the app, with its file. */
const uses = sources(SRC).flatMap((file) =>
  [...readFileSync(file, "utf8").matchAll(/<LiveFailure\b[\s\S]*?\/>/g)].map((m) => ({ file: file.slice(SRC.length + 1), jsx: m[0] })),
);

describe("live failure fallbacks", () => {
  test("the notice is used in the scenes that call Jev live", () => {
    expect(uses.length).toBeGreaterThanOrEqual(6);
  });

  test("every scene says what is still on screen", () => {
    for (const u of uses) expect({ file: u.file, hasFallback: /\bfallback=/.test(u.jsx) }).toEqual({ file: u.file, hasFallback: true });
  });

  test("the shared messages never claim a fallback; scenes do that", () => {
    for (const status of [undefined, 401, 403, 402, 429, 503, 0]) {
      const f = describeFailure(Object.assign(new Error("x"), status === undefined ? {} : { status }));

      expect(`${f.title} ${f.message}`).not.toMatch(/still work|recorded answers/i);
    }

    expect(describeFailure(new TypeError("Failed to fetch")).message).not.toMatch(/still work/i);
  });
});
