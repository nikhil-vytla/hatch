/**
 * Records Jev's answer for every item × sequence in PROTOCOL.md. It resumes from rows already
 * answered, stops at the spending cap, and stops after 5 failures in a row. Failed rows are
 * recorded as failures and never counted.
 *
 *   bun packages/arena/spine/record.ts --pilot    # 10 requests
 *   bun packages/arena/spine/record.ts            # the rest
 *   bun packages/arena/spine/record.ts --dry-run  # list them; sends nothing
 */
import type { Payload } from "../../jev-client/src/index";
import { jevEndpoint } from "../../jev-client/src/endpoints";
import { readRows } from "../../jev-client/src/recordings";
import { jevErrorRow, jevRow, listPrice, noRetry, record, recorderKey, type Job } from "../../jev-client/src/recorder";
import { allSequences, ITEMS, requestFor, sequenceId } from "./model";

const CAP_USD = 0.25;
const PILOT = 10;
const CONCURRENCY = 3;

export const out = new URL("./recordings/spine.jsonl", import.meta.url);

export const jobs = (): Job[] =>
  ITEMS.flatMap((it) => allSequences().map((pushes) => ({ id: sequenceId(it, pushes), request: requestFor(it, pushes) as Payload })));

if (import.meta.main) {
  await import("../../../experience-prototypes/scripts/credentials");

  const { dryRun, apiKey } = recorderKey();
  const prior = readRows(out);
  const before = prior.reduce((s, r) => s + (r.status === "ok" && typeof r.costUsd === "number" ? r.costUsd : 0), 0);
  const result = await record(jobs(), jevEndpoint({ apiKey, maxAttempts: 4, deadlineMs: 30_000 }), {
    out,
    dryRun,
    prior,
    limit: process.argv.includes("--pilot") ? PILOT : undefined,
    concurrency: CONCURRENCY,
    maxUsd: CAP_USD,
    spentUsd: before,
    spend: (reply) => listPrice(reply.raw!) ?? 0,
    retry: noRetry,
    okRow: jevRow,
    errorRow: jevErrorRow,
    onJob: (s) => {
      if (s.jobs % 100 === 0) console.log(`${s.jobs} sent, $${s.spentUsd.toFixed(5)} so far`);
    },
  });

  if (!dryRun)
    console.log(`Sent ${result.sent}; $${(before + result.spentUsd).toFixed(5)} in total at list price.${result.stopped ? ` Stopped: ${result.stopped}.` : ""}`);
}
