import "../experience-prototypes/scripts/credentials";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../..");
const key = process.env.AI_GATEWAY_API_KEY;
if (!key)
  throw new Error(
    "Cannot run exact credential scan without the configured recording key",
  );
const names = new Set<string>();
for (const args of [
  ["diff", "--name-only"],
  [
    "ls-files",
    "--others",
    "--exclude-standard",
    "jev-experiments/local-models-and-games",
    "jev-experiments/experience-prototypes/src",
  ],
]) {
  const p = Bun.spawnSync(["git", ...args], { cwd: root });
  if (p.exitCode) throw new Error("Could not enumerate changed files");
  for (const name of p.stdout.toString().trim().split("\n").filter(Boolean))
    names.add(resolve(root, name));
}
function visit(path: string) {
  for (const name of readdirSync(path)) {
    const p = resolve(path, name);
    if (statSync(p).isDirectory()) visit(p);
    else names.add(p);
  }
}
visit(resolve(root, "jev-experiments/experience-prototypes/dist"));
let count = 0;
for (const path of names) {
  if (!existsSync(path) || statSync(path).isDirectory()) continue;
  count++;
  const bytes = readFileSync(path);
  if (bytes.includes(Buffer.from(key)))
    throw new Error(`Configured key found in ${path.replace(root + "/", "")}`);
}
console.log(
  JSON.stringify({
    checked_files: count,
    configured_key_exposed: false,
    scope:
      "Changed/new investigation source plus complete production dist; exact configured recording-key bytes.",
  }),
);
