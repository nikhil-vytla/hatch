/**
 * Records Jev on facts for Count with me: Jev cannot see, so each request carries the detector's
 * boxes (detr.jsonl) as text and asks the same typed questions as the vision model. One request
 * per image; resumes from what is recorded; stops before list-price spend passes the cap.
 * `--pilot` records two images first; `--dry-run` lists the requests and sends nothing.
 *
 *   bun live-worlds/count/record-jev.ts [--pilot] [--dry-run]
 */
import { readFileSync } from "node:fs";
import { jevEndpoint } from "../../packages/jev-client/src/endpoints";
import { readRows } from "../../packages/jev-client/src/recordings";
import { jevErrorRow, jevRow, listPrice, noRetry, record, recorderKey, type Job } from "../../packages/jev-client/src/recorder";
import type { Payload } from "../../packages/jev-client/src/wire";
import { jevRequest, type Detection, type Item } from "./model";

const CAP_USD = 0.1;

export const out = new URL("./recordings/jev.jsonl", import.meta.url);

export const items = () => (JSON.parse(readFileSync(new URL("./items.json", import.meta.url), "utf8")) as { items: Item[] }).items;

/** One request per image, carrying its detections; `pilot` picks the first and last images. */
export function jobs(pilot = false): Job[] {
  const detections = new Map<string, Detection[]>(readRows<{ id: string; detections: Detection[] }>(new URL("./recordings/detr.jsonl", import.meta.url)).map((r) => [r.id, r.detections]));
  const all = items();

  return (pilot ? [all[0], all[all.length - 1]] : all).map((item) => {
    const found = detections.get(item.id);

    if (!found) throw Error(`No detections for ${item.id}; run scripts/count-detect.ts first.`);

    return { id: item.id, request: jevRequest(item, found) as Payload };
  });
}

if (import.meta.main) {
  await import("../../experience-prototypes/scripts/credentials");

  const { dryRun, apiKey } = recorderKey();
  const spentBefore = readRows(out).reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const result = await record(jobs(process.argv.includes("--pilot")), jevEndpoint({ apiKey, maxAttempts: 3, deadlineMs: 20_000 }), {
    out,
    dryRun,
    maxUsd: CAP_USD,
    spentUsd: spentBefore,
    // Stop before a request like the largest so far could pass the cap.
    worstUsd: (_job, s) => s.largestUsd,
    spend: (reply) => listPrice(reply.raw!) ?? 0,
    failFast: Infinity,
    retry: noRetry,
    okRow: jevRow,
    errorRow: jevErrorRow,
  });

  if (!dryRun) {
    if (result.stopped) console.log(`Stopped near the $${CAP_USD} cap.`);
    console.log(`Sent ${result.sent} requests; list-price total $${(spentBefore + result.spentUsd).toFixed(5)}.`);
  }
}
