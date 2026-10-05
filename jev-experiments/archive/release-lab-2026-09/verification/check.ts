import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../../..");
const checks = [
  [
    "shared runtime, routing and scene tests",
    ["bun", "test", "runtime", "routing", "materials", "playable"],
    "jev-experiments/roadmap",
  ],
  ["TypeScript toolkit", ["bun", "run", "check"], "jev-experiments/roadmap"],
  [
    "production build",
    ["bun", "run", "build"],
    "jev-experiments/experience-prototypes",
  ],
  [
    "application and full engine suite",
    ["bun", "run", "test"],
    "jev-experiments/experience-prototypes",
  ],
  [
    "TypeScript adapter",
    ["bun", "test"],
    "jev-experiments/adapters/typescript",
  ],
  [
    "Python lab",
    ["uv", "run", "--extra", "dev", "pytest", "-q", "tests"],
    "jev-experiments",
  ],
  [
    "historical Apple metrics",
    ["uv", "run", "python", "local-models-and-games/apple/test_metrics.py"],
    "jev-experiments",
  ],
  [
    "typed study metrics",
    [
      "uv",
      "run",
      "python",
      "-m",
      "unittest",
      "discover",
      "-s",
      "roadmap/training",
      "-p",
      "test_*.py",
    ],
    "jev-experiments",
  ],
  [
    "local toolkit contracts",
    [
      "uv",
      "run",
      "python",
      "-m",
      "unittest",
      "discover",
      "-s",
      "roadmap/mac",
      "-p",
      "test_*.py",
    ],
    "jev-experiments",
  ],
  [
    "publication integrity",
    ["bun", "verification/publication.ts"],
    "jev-experiments/roadmap",
  ],
  [
    "downloadable evidence integrity",
    ["bun", "verification/evidence-assets.ts"],
    "jev-experiments/roadmap",
  ],
] as const;
const rows = [];
for (const [name, args, cwd] of checks) {
  const start = performance.now(),
    r = spawnSync(args[0], args.slice(1), {
      cwd: resolve(root, cwd),
      encoding: "utf8",
      timeout: 180000,
    });
  const log = r.stdout + "\n" + r.stderr;
  rows.push({
    name,
    command: args,
    cwd,
    exitCode: r.status,
    elapsedMs: performance.now() - start,
    output: log.slice(-12000),
  });
  console.log(`${r.status === 0 ? "PASS" : "FAIL"} ${name}`);
}
writeFileSync(
  resolve(import.meta.dir, "checks.json"),
  JSON.stringify(
    { checks: rows, passed: rows.every((r) => r.exitCode === 0) },
    null,
    2,
  ) + "\n",
);
if (rows.some((r) => r.exitCode !== 0)) process.exitCode = 1;
