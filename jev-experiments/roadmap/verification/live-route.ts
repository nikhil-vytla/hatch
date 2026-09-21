import "../../experience-prototypes/scripts/credentials";
import handler from "../routing/web-handler";
import { defaultWebTask } from "../routing/web-registry";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
const key = process.env.AI_GATEWAY_API_KEY;
if (!key) throw Error("AI_GATEWAY_API_KEY required.");
const output = new URL("./live-route.json", import.meta.url);
if (existsSync(output))
  throw Error(
    "Preserve the preceding live-route evidence before recording a new implementation.",
  );
let status = 200,
  result: any;
await handler(
  {
    method: "POST",
    headers: { authorization: `Bearer ${key}` },
    body: { task: defaultWebTask, maxCostUsd: 0.05 },
  },
  {
    setHeader() {},
    status(n: number) {
      status = n;
      return this;
    },
    json(x: unknown) {
      result = x;
    },
  },
);
const directory = mkdtempSync(join(tmpdir(), "jev-web-route-"));
writeFileSync(
  join(directory, "sum.ts"),
  "export function totalThrough(n: number): number {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\n",
);
writeFileSync(
  join(directory, "sum.test.ts"),
  "import {test,expect} from 'bun:test'; import {totalThrough} from './sum'; test('inclusive totals',()=>{for(const n of [0,1,2,10,42])expect(totalThrough(n)).toBe(n*(n+1)/2)});\n",
);
const before = spawnSync("bun", ["test"], { cwd: directory, encoding: "utf8" });
const artifact = result?.outcome?.artifact;
let applyStatus: number | null = null;
let strictCheck: {
  status: number | null;
  stdout: string;
  stderr: string;
} | null = null;
if (artifact?.kind === "patch") {
  const patch = join(directory, "proposal.diff");
  writeFileSync(patch, artifact.text);
  const check = spawnSync(
    "git",
    ["apply", "--check", "--include=sum.ts", patch],
    { cwd: directory, encoding: "utf8" },
  );
  strictCheck = {
    status: check.status,
    stdout: check.stdout,
    stderr: check.stderr,
  };
  if (check.status === 0)
    applyStatus = spawnSync("git", ["apply", "--include=sum.ts", patch], {
      cwd: directory,
      encoding: "utf8",
    }).status;
}
const after = spawnSync("bun", ["test"], { cwd: directory, encoding: "utf8" });
const sources = Object.fromEntries(
  [
    "live-route.ts",
    "../routing/web-handler.ts",
    "../routing/execute.ts",
    "../routing/http-executor.ts",
    "../routing/artifacts.ts",
  ].map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(new URL(path, import.meta.url)))
      .digest("hex"),
  ]),
);
const report = {
  recordedAt: new Date().toISOString(),
  status,
  sources,
  task: defaultWebTask,
  result,
  independentCheck: {
    baselineExit: before.status,
    baseline: before.stdout + before.stderr,
    strictCheck,
    strictPatchApplied: applyStatus === 0,
    patchApplied: applyStatus === 0,
    testsExit: after.status,
    tests: after.stdout + after.stderr,
    hostRepairApplied: false,
    toolkitNormalizationApplied: Boolean(artifact?.repair),
  },
  billingVerified: false,
};
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    status,
    resultStatus: result?.status,
    patchApplied: applyStatus === 0,
    testExit: after.status,
  }),
);
if (
  status !== 200 ||
  result?.status !== "ok" ||
  applyStatus !== 0 ||
  after.status !== 0
)
  process.exitCode = 1;
