import { test, expect } from "bun:test";
import { assertPreserved } from "../../../verification/record-integrity";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("publication preservation checks retain empty object shape", () => {
  for (const replacement of [null, 42, [], false])
    expect(() =>
      assertPreserved({ metadata: {} }, { metadata: replacement }),
    ).toThrow("Public object changed");
  expect(() =>
    assertPreserved(
      { metadata: {} },
      { metadata: { added: "allowed enrichment" } },
    ),
  ).not.toThrow();
});
test("patch application preflights CI source and conflicts before edits", () => {
  const execution = spawnSync(
    "python3",
    [resolve(import.meta.dir, "patch-probes.py")],
    { encoding: "utf8" },
  );
  expect(execution.status).toBe(0);
  const cases = JSON.parse(execution.stdout);
  expect(cases.find((x: any) => x.case === "normal")).toMatchObject({
    exitCode: 0,
    fixtureAfter: "new",
    workflowExists: true,
  });
  for (const name of ["missing-ci-source", "conflicting-ci"])
    expect(cases.find((x: any) => x.case === name)).toMatchObject({
      exitCode: 1,
      fixtureAfter: "old",
    });
});
