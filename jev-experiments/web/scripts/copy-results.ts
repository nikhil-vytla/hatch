import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
const source = new URL("../../results/", import.meta.url);
const destination = new URL("../public/results/", import.meta.url);
mkdirSync(destination, { recursive: true });
// Vercel receives the prepared web folder, without its parent research files.
// Only refresh generated copies when building from the full local project.
if (existsSync(source)) {
  for (const name of readdirSync(destination))
    if (name.endsWith(".json")) unlinkSync(new URL(name, destination));
  for (const name of readdirSync(source)) {
    if (name.endsWith(".json") && !["smoke.json", "access.json"].includes(name))
      copyFileSync(new URL(name, source), new URL(name, destination));
  }
}
const reports = new URL("../public/research/", import.meta.url);
mkdirSync(reports, { recursive: true });
for (const name of ["README.md", "SOURCES.md", "IDEA_GARDEN.md"]) {
  const original = new URL(`../../${name}`, import.meta.url);
  if (existsSync(original)) copyFileSync(original, new URL(name, reports));
}
