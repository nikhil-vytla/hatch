import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readRecord } from "../experience-prototypes/scripts/records";
import { collection } from "./collection";
import { presets, shards, shardQuestion, finalQuestion, finalists } from "./protocol";

const here = import.meta.dir, result = readRecord(resolve(here, "results.jsonl")).result;
const lib = await collection(), groups = shards(lib.icons);
const events = readFileSync(resolve(here, "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const responses = events.filter(e => e.kind === "response"), byId = new Map(responses.map(e => [e.id, e]));
const assert = (ok: unknown, message: string) => { if (!ok) throw Error(message); };
assert(byId.size === responses.length, "Duplicate accepted response");
assert(result.library.sha256 === lib.sha256, "Library changed");
const reconstruct = (id: string, body: unknown) => {
  const response = byId.get(id);
  assert(response, `Missing ${id}`);
  assert(response.hash === createHash("sha256").update(JSON.stringify(body)).digest("hex"), `Request changed: ${id}`);
  return response.output.answers;
};
for (const preset of presets) {
  const state = { title: preset.title, context: preset.context }, answers: Record<string, any> = {};
  for (let start = 0; start < groups.length; start += 8) {
    const questions = Object.fromEntries(groups.slice(start, start + 8).map((g, i) => ["shard_" + (start + i), shardQuestion(g)]));
    Object.assign(answers, reconstruct(`${preset.id}/group/${start}`, { state, questions }));
  }
  const winners = finalists(groups, answers), final = winners.length ? reconstruct(`${preset.id}/final`, { state, questions: { icon: finalQuestion(winners) } }).icon : null;
  const row = result.rows.find((r: any) => r.id === preset.id);
  assert(row?.status === "complete", `Incomplete ${preset.id}`);
  assert(JSON.stringify(row.shardAnswers) === JSON.stringify(answers), `Answer drift: ${preset.id}`);
  assert(JSON.stringify(row.finalists) === JSON.stringify(winners.map(i => i.id)), `Finalist drift: ${preset.id}`);
  assert(JSON.stringify(row.answer) === JSON.stringify(final), `Final answer drift: ${preset.id}`);
  assert(row.picked === (final?.value ?? "none"), `Winner drift: ${preset.id}`);
  assert(row.picked === "none" || winners.some(i => i.id === row.picked), `Invalid finalist: ${preset.id}`);
}
const summary = { verified: true, icons: lib.icons.length, cases: presets.length, acceptedRequests: responses.length, attempts: events.filter(e => e.kind === "attempt").length, library_sha256: lib.sha256 };
writeFileSync(resolve(here, "verification.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
