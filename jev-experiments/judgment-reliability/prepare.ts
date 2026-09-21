import { writeRecord } from "../experience-prototypes/scripts/records";
import { mkdirSync, writeFileSync, copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./analyze";
import { hash } from "./protocol";
const here = dirname(fileURLToPath(import.meta.url));
export function prepareJudgmentReliability(target: string) {
  const { result, cases } = summarize();
  mkdirSync(resolve(target, "cases"), { recursive: true });
  writeFileSync(resolve(target, "analysis.json"), JSON.stringify(result.analysis, null, 2) + "\n");
  const prepared = new Set<string>();
  for (const c of cases) { const body = JSON.stringify(c) + "\n"; const name = `${c.pair_id}-${hash(body).slice(0, 12)}.json`; writeFileSync(resolve(target, "cases", name), body); prepared.add(name); const entry = result.case_index.find(i => i.pair_id === c.pair_id)!; Object.assign(entry, { chunk: name }); }
  for (const name of readdirSync(resolve(target, "cases"))) if (/^[0-9a-f-]+-[0-9a-f]{12}\.json$/.test(name) && !prepared.has(name)) unlinkSync(resolve(target, "cases", name));
  copyFileSync(resolve(here, "events.jsonl"), resolve(target, "evidence.jsonl"));
  copyFileSync(resolve(here, "cases.jsonl"), resolve(target, "cases.jsonl"));
  copyFileSync(resolve(here, "manifest.json"), resolve(target, "manifest.json"));
  return { name: "judgment-reliability", result };
}
if (import.meta.main) { const document = prepareJudgmentReliability(resolve(process.argv[2] ?? "jev-experiments/experience-prototypes/public/judgment-reliability")); writeRecord(resolve(here, "results.jsonl"), document); console.log(JSON.stringify({ pairs: document.result.case_index.length, completed: document.result.availability.completed, target: process.argv[2] })); }
