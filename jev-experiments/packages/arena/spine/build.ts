/**
 * Builds public/spine/spine.json: the items, the pushes and Jev's recorded answer for every
 * sequence, so the toy works without a key. A sequence with no answered row is left out, never
 * invented.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { latestById, readRows } from "../../jev-client/src/recordings";
import { answered, type Row } from "./analyze";
import { ITEMS, PUSH_LABELS, PUSHES } from "./model";

export type SpineRecorded = {
  pYes: number;
  latencyMs: number | null;
  costUsd: number | null;
  at: string | null;
  servedBy: string | null;
};

type Recorded = Row & { servedBy?: string | null };

export function buildSpine(root: string, outDir: string) {
  const path = join(root, "recordings/spine.jsonl");
  const rows = readRows<Recorded>(path);
  const p = answered(rows);
  const last = latestById(rows);

  const recorded = Object.fromEntries(
    [...p].map(([id, pYes]): [string, SpineRecorded] => {
      const r = last.get(id);

      return [id, { pYes, latencyMs: r?.latencyMs ?? null, costUsd: r?.costUsd ?? null, at: r?.at ?? null, servedBy: r?.servedBy ?? null }];
    }),
  );

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "spine.json"), JSON.stringify({ items: ITEMS, pushes: PUSHES, labels: PUSH_LABELS, recorded }) + "\n");

  return p.size;
}
