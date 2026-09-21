import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeSingleHunkCounts,
  parseArtifact,
  validatePatchHunks,
} from "./artifacts";
const source =
  "export function totalThrough(n: number): number {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n";
const patch =
  "--- a/sum.ts\n+++ b/sum.ts\n@@ -1,5 +1,6 @@\n" +
  source
    .trimEnd()
    .split("\n")
    .map((line) => "-" + line)
    .join("\n") +
  "\n" +
  source
    .replace("i < n", "i <= n")
    .trimEnd()
    .split("\n")
    .map((line) => "+" + line)
    .join("\n") +
  "\n";
const artifact = () =>
  parseArtifact(JSON.stringify({ kind: "patch", text: patch }), {
    normalizeSingleHunkCounts: true,
  });
test("normalization changes only the two count fields and retains the original malformed proposal", () => {
  expect(() => validatePatchHunks(patch)).toThrow();
  const normalized = artifact();
  expect(normalized.repair).toMatchObject({
    kind: "single-hunk-counts-v1",
    originalWasMalformed: true,
    originalText: patch,
    originalHeader: "@@ -1,5 +1,6 @@",
    normalizedHeader: "@@ -1,5 +1,5 @@",
    headerLine: 3,
  });
  expect(normalized.text).toBe(
    patch.replace("@@ -1,5 +1,6 @@", "@@ -1,5 +1,5 @@"),
  );
  expect(() => validatePatchHunks(normalized.text)).not.toThrow();
});
test("ambiguous or structurally invalid patches are never normalized", () => {
  const malformed = [
    patch + "@@ -9,1 +9,2 @@\n-a\n+b\n",
    patch.replace("+++ b/sum.ts", "not a file header"),
    patch.replace("-  let total = 0;", "  let total = 0;\nunprefixed prose"),
    patch.slice(0, -1),
    patch.replaceAll("\n", "\r\n"),
    patch.replace("@@ -1,5", "@@ -0,5"),
    patch.replace("--- a/sum.ts", "--- /dev/null"),
    patch.replace("-  let total = 0;", "--- a/ambiguous"),
  ];
  for (const value of malformed)
    expect(normalizeSingleHunkCounts(value)).toBeNull();
});
test("already valid patches have no repair claim", () => {
  const valid = patch.replace("+1,6 @@", "+1,5 @@");
  const result = parseArtifact(JSON.stringify({ kind: "patch", text: valid }), {
    normalizeSingleHunkCounts: true,
  });
  expect(result.text).toBe(valid);
  expect(result.repair).toBeUndefined();
  expect(normalizeSingleHunkCounts(valid)).toBeNull();
});
async function command(directory: string, args: string[]) {
  const proc = Bun.spawn(args, {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text(),
    stderr = await new Response(proc.stderr).text();
  return { exitCode: await proc.exited, stdout, stderr };
}
test("host strict application rejects original counts, accepts disclosed normalization, and independently tests source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-normalization-"));
  try {
    await command(directory, ["git", "init", "-q"]);
    await writeFile(join(directory, "sum.ts"), source);
    await writeFile(join(directory, "proposal.diff"), patch);
    await writeFile(
      join(directory, "sum.test.ts"),
      'import {test,expect} from "bun:test";import {totalThrough} from "./sum";test("inclusive totals",()=>{for(const n of [0,1,2,10,42])expect(totalThrough(n)).toBe(n*(n+1)/2)});',
    );
    expect((await command(directory, ["bun", "test"])).exitCode).toBe(1);
    expect(
      (await command(directory, ["git", "apply", "--check", "proposal.diff"]))
        .exitCode,
    ).not.toBe(0);
    await writeFile(join(directory, "proposal.diff"), artifact().text);
    expect(
      (await command(directory, ["git", "apply", "--check", "proposal.diff"]))
        .exitCode,
    ).toBe(0);
    expect(
      (await command(directory, ["git", "apply", "proposal.diff"])).exitCode,
    ).toBe(0);
    expect((await command(directory, ["bun", "test"])).exitCode).toBe(0);
    expect(await readFile(join(directory, "sum.ts"), "utf8")).toBe(
      source.replace("i < n", "i <= n"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("syntax normalization cannot make a mismatched source patch applicable", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "jev-normalization-mismatch-"),
  );
  try {
    await command(directory, ["git", "init", "-q"]);
    await writeFile(join(directory, "sum.ts"), "unrelated source\n");
    await writeFile(join(directory, "proposal.diff"), artifact().text);
    expect(
      (await command(directory, ["git", "apply", "--check", "proposal.diff"]))
        .exitCode,
    ).not.toBe(0);
    expect(await readFile(join(directory, "sum.ts"), "utf8")).toBe(
      "unrelated source\n",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SQL and Lua comment deletions strictly apply after count-only normalization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-comment-hunk-"));
  try {
    await command(directory, ["git", "init", "-q"]);
    for (const [file, remaining] of [
      ["query.sql", "SELECT 1;"],
      ["program.lua", "return 1"],
    ]) {
      const original = `--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n--- obsolete comment\n ${remaining}\n`;
      await writeFile(
        join(directory, file),
        `-- obsolete comment\n${remaining}\n`,
      );
      await writeFile(join(directory, "proposal.diff"), original);
      expect(
        (await command(directory, ["git", "apply", "--check", "proposal.diff"]))
          .exitCode,
      ).not.toBe(0);
      const normalized = parseArtifact(
        JSON.stringify({ kind: "patch", text: original }),
        { normalizeSingleHunkCounts: true },
      );
      expect(normalized.repair?.originalText).toBe(original);
      expect(normalized.text).toBe(original.replace("+1,2 @@", "+1,1 @@"));
      await writeFile(join(directory, "proposal.diff"), normalized.text);
      expect(
        (await command(directory, ["git", "apply", "--check", "proposal.diff"]))
          .exitCode,
      ).toBe(0);
      expect(
        (await command(directory, ["git", "apply", "proposal.diff"])).exitCode,
      ).toBe(0);
      expect(await readFile(join(directory, file), "utf8")).toBe(
        remaining + "\n",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
