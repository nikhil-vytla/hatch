import { stat } from "node:fs/promises";
import { join } from "node:path";

const dir = import.meta.dir;
const catalog = await Bun.file(join(dir, "sources.json")).json();
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
check(catalog.works.length >= 12 && catalog.works.length <= 18, "Expected 12–18 inspected works");
const ids = new Set<string>();
let interacted = 0;
let evidence = 0;
for (const work of catalog.works) {
  check(!ids.has(work.id), `Duplicate source: ${work.id}`);
  ids.add(work.id);
  check(new URL(work.url).protocol === "https:", `Invalid source URL: ${work.id}`);
  for (const field of ["title", "type", "status", "confidence", "entry", "feedback", "progression", "failureLesson", "modelAndConfidence", "checkpoint", "accessibility"]) {
    check(typeof work[field] === "string" && work[field].length > 0, `Missing ${field}: ${work.id}`);
  }
  check(work.creators.length > 0 && work.reuse.license && work.reuse.advice, `Missing attribution/reuse: ${work.id}`);
  check(Array.isArray(work.observed) && Array.isArray(work.documented), `Missing evidence distinction: ${work.id}`);
  for (const url of work.primaryLinks ?? []) check(new URL(url).protocol === "https:", `Invalid primary URL: ${work.id}`);
  if (work.status === "personally interacted") {
    interacted++;
    check(work.observed.length > 0 && work.evidence?.length > 0, `Interaction lacks evidence: ${work.id}`);
  }
  for (const path of work.evidence ?? []) {
    check(!path.includes("..") && path.startsWith("output/playwright/"), `Unexpected evidence path: ${path}`);
    const file = await stat(join(dir, path));
    check(file.size > 0 && file.size < 2_000_000, `Screenshot size outside limits: ${path}`);
    evidence++;
  }
}
check(interacted >= 4, "At least four personal interactions required");
const proposals = await Bun.file(join(dir, "proposals.md")).text();
const proposalIds = [...proposals.matchAll(/^### ((?:P|N)\d+)\./gm)].map(match => match[1]);
check(proposalIds.length >= 8 && proposalIds.length <= 12, "Expected 8–12 proposals");
check(new Set(proposalIds).size === proposalIds.length, "Duplicate proposal identifier");
check(["P1", "P2", "P3", "N1", "N2", "N3"].every(id => proposalIds.includes(id)), "Missing priority proposals");
for (const file of ["NOTES.md", "README.md", "patterns.md", "_summary.md"]) check((await Bun.file(join(dir, file)).text()).trim(), `Empty ${file}`);
console.log(JSON.stringify({ works: ids.size, personallyInteracted: interacted, evidenceFiles: evidence, proposals: proposalIds.length, status: "valid" }));
