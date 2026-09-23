import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { history, type Workspace } from "@strive/workspace";
import { loadWorkspace, saveWorkspace } from "./store";

const base: Workspace = {
  version: 1,
  columns: [{ id: "main", grow: 1, panels: ["transcript"] }],
  panels: [{ id: "transcript", kind: "transcript" }],
};

test("a saved workspace loads back", () => {
  const dir = mkdtempSync(join(tmpdir(), "strv-store-"));
  const h = { ...history(base), decided: ["a"] };

  saveWorkspace(dir, h);

  expect(loadWorkspace(dir)).toEqual(h);
});

test("a save doesn't undo decisions another window saved since this one loaded", () => {
  const dir = mkdtempSync(join(tmpdir(), "strv-store-"));
  saveWorkspace(dir, { ...history(base), decided: ["from-a"] });

  saveWorkspace(dir, { ...history(base), decided: ["from-b"] });

  expect(loadWorkspace(dir)?.decided.toSorted()).toEqual(["from-a", "from-b"]);
});

test("a save that fails decides nothing, so its proposals are offered again", () => {
  const dir = mkdtempSync(join(tmpdir(), "strv-store-"));
  saveWorkspace(dir, history(base));
  // The layout can't be written: its temporary file's name is taken by a directory.
  mkdirSync(join(dir, `workspace.json.${process.pid}.tmp`));

  expect(() => saveWorkspace(dir, { ...history(base), decided: ["accepted"] })).toThrow();

  expect(loadWorkspace(dir)?.decided).toEqual([]);
});

// Each window is its own process, so saves from two of them interleave.
test("no decision is lost when windows in other processes save at the same time", async () => {
  const dir = mkdtempSync(join(tmpdir(), "strv-store-"));
  const [writers, saves] = [6, 25];
  const start = Date.now() + 500;

  const script = `
    import { saveWorkspace } from ${JSON.stringify(resolve(import.meta.dir, "store.ts"))};
    const base = ${JSON.stringify(base)};
    while (Date.now() < ${start});
    const decided = [];
    for (let i = 0; i < ${saves}; i++) {
      decided.push(process.argv[1] + "-" + i);
      saveWorkspace(${JSON.stringify(dir)}, { base, edits: [], nextId: 1, decided });
    }`;

  const procs = Array.from({ length: writers }, (_, w) =>
    Bun.spawn(["bun", "-e", script, `w${w}`], { stdout: "inherit", stderr: "inherit" }),
  );

  const codes = await Promise.all(procs.map((p) => p.exited));

  expect(codes).toEqual(Array(writers).fill(0));
  const expected = Array.from({ length: writers }, (_, w) => Array.from({ length: saves }, (_, i) => `w${w}-${i}`));
  expect(loadWorkspace(dir)?.decided.toSorted()).toEqual(expected.flat().toSorted());
}, 30_000);
