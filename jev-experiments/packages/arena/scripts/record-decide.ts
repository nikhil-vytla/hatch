/**
 * Records Jev on Decide's deck (src/decide/deck.ts): one request per decision and setup, the
 * exact request the page shows. Same protocol as record-checkable.ts: a seeded shuffled order,
 * one request at a time with a 700 ms gap, busy replies waited out and every attempt logged,
 * weak answers never re-asked. Truths are never sent. Append-only and resumable.
 *
 *   bun jev-experiments/packages/arena/scripts/record-decide.ts [--dry-run]
 */
import { jevEndpoint } from "../../jev-client/src/endpoints";
import { attemptErrorRow, attemptRow, record, recorderKey, waitOutBusy, type Job } from "../../jev-client/src/recorder";
import type { Payload } from "../../jev-client/src/wire";
import { mulberry32, shuffled } from "../../seeded/src/index";
import { DECK, requestFor } from "../src/decide/deck";

export const out = new URL("../recordings/decide.jsonl", import.meta.url);

/** One request per decision and setup, in the recording's seeded order. */
export const jobs = (): Job[] =>
  shuffled(
    DECK.flatMap((d) => d.setups.map((s) => ({ id: `${d.id}:${s.id}`, request: requestFor(d, s) as Payload }))),
    mulberry32(20260928),
  );

if (import.meta.main) {
  await import("../../../experience-prototypes/scripts/credentials");

  const { dryRun, apiKey } = recorderKey();
  const all = jobs();
  const result = await record(all, jevEndpoint({ apiKey, maxAttempts: 1, deadlineMs: 20_000 }), {
    out,
    dryRun,
    failFast: Infinity,
    retry: waitOutBusy,
    gapMs: 700,
    okRow: attemptRow,
    errorRow: attemptErrorRow,
    onStart: (todo, skipped) => console.log(`${all.length} requests, ${skipped} recorded, ${todo} to ask.`),
  });

  if (!dryRun) console.log(result.stopped ? `Stopped: ${result.stopped}` : "Done.");
}
