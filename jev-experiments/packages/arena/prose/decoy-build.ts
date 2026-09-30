/**
 * Builds public/decoy/decoy.json for the decoy scene: each scenario's options, the exact request
 * per set and order, and Jev's recorded answer to it. Read from the frozen prose recording; a set
 * with no answered row is left out, never invented.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DECOY_ITEMS } from "./items";
import { allJobs } from "./variants";

type Row = {
  id: string;
  status: string;
  at?: string;
  latencyMs?: number;
  servedBy?: string;
  answers?: { q?: { probabilities?: Record<string, number> } };
};

function readRows(dir: string) {
  const raw = join(dir, "recordings/prose.jsonl");
  const gz = join(dir, "recordings/prose.jsonl.gz");
  const text = existsSync(raw)
    ? readFileSync(raw, "utf8")
    : existsSync(gz)
      ? gunzipSync(readFileSync(gz)).toString("utf8")
      : "";

  // A retried request is logged once per attempt; the last answered attempt stands.
  const rows = new Map<string, Row>();

  for (const line of text.split("\n")) {
    if (!line.startsWith('{"id":"decoy:')) continue;

    const row: Row = JSON.parse(line);

    if (row.status === "ok" && row.answers?.q?.probabilities) rows.set(row.id, row);
  }

  return rows;
}

export function buildDecoy(dir: string, outDir: string) {
  const rows = readRows(dir);
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
