/**
 * Builds public/decoy/decoy.json for the decoy scene: each scenario's options, the exact request
 * per set and order, and Jev's recorded answer to it. Read from the frozen prose recording; a set
 * with no answered row is left out, never invented.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { latestById, readRows } from "../../jev-client/src/recordings";
import { DECOY_ITEMS } from "./items";
import { allJobs } from "./variants";

type Row = {
  id: string;
  status: string;
  at?: string;
  latencyMs?: number;
  servedBy?: string;
  inputTokens?: number;
  costUsd?: number;
  answers?: { q?: { probabilities?: Record<string, number> } };
};

/** The decoy rows of the prose recording (the working copy, else the committed .gz). */
function decoyRows(dir: string) {
  // A retried request is logged once per attempt; the last answered attempt stands.
  return latestById(readRows<Row>(join(dir, "recordings/prose.jsonl")), (row) => row.id.startsWith("decoy:") && row.status === "ok" && !!row.answers?.q?.probabilities);
}

export function buildDecoy(dir: string, outDir: string) {
  const rows = decoyRows(dir);
  const jobs = allJobs().filter((j) => j.study === "decoy");

  const recorded = jobs.flatMap((job) => {
    const row = rows.get(job.id);
    const keyMap = job.read.kind === "dist" ? job.read.keyMap : undefined;

    if (!row?.answers?.q?.probabilities || !keyMap) return [];

    // The recording names options Ash, Birch and Cedar; the scene reads them as a, b and the decoy.
    const probabilities = Object.fromEntries(
      Object.entries(row.answers.q.probabilities).map(([name, p]) => [keyMap[name] ?? name, p]),
    );

    return [
      {
        id: job.id,
        item: job.item,
        set: job.meta?.decoy,
        order: job.meta?.order,
        request: job.request,
        probabilities,
        at: row.at,
        latencyMs: row.latencyMs ?? null,
        servedBy: row.servedBy ?? null,
        inputTokens: row.inputTokens ?? null,
        costUsd: row.costUsd ?? null,
        // The answer exactly as recorded, wire option names included, for the receipt's raw view.
        answers: row.answers,
      },
    ];
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "decoy.json"),
    JSON.stringify({ scenarios: DECOY_ITEMS, recorded }) + "\n",
  );

  return recorded.length;
}
