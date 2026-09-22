import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareCapabilityAtlas } from "./prepare-atlas";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

test("explanations are bound to source and app wiring, including missing files", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-atlas-test-")); roots.push(root);
  const lab = join(root, "lab"), folder = join(lab, "capability-atlas-2026-09-22"), output = join(root, "public");
  mkdirSync(folder, { recursive: true }); mkdirSync(output);
  const evidence = (path: string, value: string) => {
    writeFileSync(join(root, path), value);
    return { path, sha256: createHash("sha256").update(value).digest("hex") };
  };
  const wiring = evidence("wiring.ts", "route to the audited component");
  const first = evidence("first.ts", "classify"), second = evidence("second.ts", "score");
  writeFileSync(join(folder, "atlas.json"), JSON.stringify({
    audited_at: "fixture", source_bindings: [wiring],
    records: [{ id: "first", evidence: [first] }, { id: "second", evidence: [second] }],
  }));
  writeFileSync(join(folder, "show-me-jev-capabilities.html"), "<h1>Authored fixture</h1>");
  const build = () => { prepareCapabilityAtlas(lab, output); return JSON.parse(readFileSync(join(output, "capability-build.json"), "utf8")).records; };
  expect(build()).toEqual({ first: true, second: true });
  const metadata = () => JSON.parse(readFileSync(join(output, "capability-build.json"), "utf8"));
  const firstBuildId = metadata().buildId;
  expect(firstBuildId).toMatch(/^[a-f0-9]{64}$/);
  build();
  expect(metadata().buildId).toBe(firstBuildId);
  writeFileSync(join(root, "first.ts"), "changed behavior");
  expect(build()).toEqual({ first: false, second: true });
  expect(metadata().buildId).not.toBe(firstBuildId);
  rmSync(join(root, "second.ts"));
  expect(build()).toEqual({ first: false, second: false });
  evidence("first.ts", "classify"); evidence("second.ts", "score");
  writeFileSync(join(root, "wiring.ts"), "route elsewhere");
  expect(build()).toEqual({ first: false, second: false });
  expect(readFileSync(join(output, "capabilities.html"), "utf8")).toBe("<h1>Authored fixture</h1>");
});
