import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const lab = resolve(".."),
  dest = resolve("public/data");
mkdirSync(dest, { recursive: true });
if (existsSync(resolve(lab, "results"))) {
  for (const f of readdirSync(resolve(lab, "results")))
    if (f.endsWith(".json") && !["access.json", "smoke.json"].includes(f))
      copyFileSync(resolve(lab, "results", f), resolve(dest, f));
}
if (existsSync("results"))
  for (const f of readdirSync("results"))
    if (f.endsWith(".json"))
      copyFileSync(resolve("results", f), resolve(dest, f));
if (existsSync(resolve(lab, ".cache/sources.json"))) {
  const py = existsSync(resolve(lab, ".venv/bin/python"))
    ? resolve(lab, ".venv/bin/python")
    : "python3";
  const p = spawnSync(py, ["scripts/enrich.py"], { stdio: "inherit" });
  if (p.status) process.exit(p.status);
}
mkdirSync("public/research", { recursive: true });
for (const name of ["README.md", "SOURCES.md", "IDEA_GARDEN.md"])
  if (existsSync(resolve(lab, name)))
    copyFileSync(resolve(lab, name), resolve("public/research", name));
if (existsSync(resolve(lab, "web/public/vision-input.png")))
  copyFileSync(
    resolve(lab, "web/public/vision-input.png"),
    "public/vision-input.png",
  );
if (existsSync("README.md"))
  copyFileSync("README.md", "public/research/EXPERIENCE_PROTOTYPES.md");
if (existsSync("extension/README.md"))
  copyFileSync("extension/README.md", "public/research/COMPANION.md");
if (existsSync("extension/manifest.json"))
  spawnSync("zip", ["-q", "-r", resolve("public/companion.zip"), "."], {
    cwd: "extension",
  });
console.log("Prepared recorded evidence and companion.");
