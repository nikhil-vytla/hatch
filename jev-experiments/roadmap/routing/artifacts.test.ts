import { expect, test } from "bun:test";
import { parseArtifact, validatePatchHunks } from "./artifacts";
const patch =
  "--- a/sum.ts\n+++ b/sum.ts\n@@ -1,3 +1,3 @@\n let total = 0;\n-for (let i = 1; i < n; i++) total += i;\n+for (let i = 1; i <= n; i++) total += i;\n return total;\n";
test("accepts a valid hunk while leaving application to caller", () =>
  expect(() => validatePatchHunks(patch)).not.toThrow());
test("rejects valid JSON carrying mismatched patch line counts", () =>
  expect(() =>
    parseArtifact(
      JSON.stringify({ kind: "patch", text: patch.replace("+1,3", "+1,4") }),
    ),
  ).toThrow("counts"));
test("rejects prose and incomplete diffs as patches", () => {
  for (const text of ["change < to <=", "@@ -1 +1 @@\n-a\n+b\n"])
    expect(() =>
      parseArtifact(JSON.stringify({ kind: "patch", text })),
    ).toThrow();
});
test("accepts a new-file diff with /dev/null old path", () =>
  expect(() =>
    validatePatchHunks(
      "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+export const answer = 42;\n",
    ),
  ).not.toThrow());

test("deleting a SQL comment is hunk content, not a new file header", () => {
  const sql =
    "--- a/query.sql\n+++ b/query.sql\n@@ -1,2 +1 @@\n--- obsolete comment\n SELECT 1;\n";
  const result = parseArtifact(JSON.stringify({ kind: "patch", text: sql }));
  expect(result.text).toBe(sql);
  expect(result.repair).toBeUndefined();
});

test("multiple files require complete structural header pairs and correct hunk counts", () => {
  const next =
    "--- a/query.sql\n+++ b/query.sql\n@@ -1 +1 @@\n-SELECT 1;\n+SELECT 2;\n";
  for (const prefix of [
    "",
    "diff --git a/query.sql b/query.sql\nindex 123..456 100644\n",
  ]) {
    expect(() => validatePatchHunks(patch + prefix + next)).not.toThrow();
    for (const header of ["--- a/query.sql\n", "+++ b/query.sql\n"])
      expect(() =>
        validatePatchHunks(patch + prefix + next.replace(header, "")),
      ).toThrow();
    expect(() =>
      validatePatchHunks(
        patch + prefix + next.replace("@@ -1 +1 @@", "@@ -2,2 +1 @@"),
      ),
    ).toThrow();
  }
});
