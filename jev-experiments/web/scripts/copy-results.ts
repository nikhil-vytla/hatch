import { readRecord } from "../../experience-prototypes/scripts/records";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
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
    if (name.endsWith(".jsonl"))
      writeFileSync(new URL(name.replace(/\.jsonl$/, ".json"), destination), JSON.stringify(readRecord(new URL(name, source))) + "\n");
  }
}
const reports = new URL("../public/research/", import.meta.url);
mkdirSync(reports, { recursive: true });
for (const name of ["README.md", "SOURCES.md", "IDEA_GARDEN.md"]) {
  const original = new URL(`../../${name}`, import.meta.url);
  if (existsSync(original)) copyFileSync(original, new URL(name, reports));
}
