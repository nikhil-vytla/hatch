/**
 * Records Jev on the checkable item bank (src/checkable/bank.json): one call per item, with
 * all of that item's questions batched, exactly the state and questions in the bank.
 *
 * Protocol (fixed before running): items asked in a seeded shuffled order so latency drift is
 * not tied to a kind; one request at a time with a 700 ms gap; a busy reply (429/503) or a
 * network failure is waited out and asked again, and every attempt is logged. The recorded
 * latency is the successful attempt's service latency. A Score the gateway drops is kept as
 * dropped. Weak answers are never re-asked. The truth stays in the bank and is never sent.
 *
 * The log is append-only; rerunning resumes and never re-asks a recorded item.
 *
 *   bun jev-experiments/packages/arena/scripts/record-checkable.ts [bank.json log] [--dry-run]
 */
import { readFileSync } from "node:fs";
import { jevEndpoint } from "../../jev-client/src/endpoints";
import { attemptErrorRow, attemptRow, record, recorderKey, waitOutBusy, type Job } from "../../jev-client/src/recorder";
import type { Payload } from "../../jev-client/src/wire";
import { bankSchema } from "../src/checkable/items";
import { mulberry32, shuffled } from "../../seeded/src/index";

export const outFor = (log: string) => new URL(`../recordings/${log}.jsonl`, import.meta.url);

/** The bank's items as requests, in the recording's seeded order. `bank` names a file in src/checkable/. */
export function jobs(bank = "bank.json"): Job[] {
  const doc = bankSchema.parse(JSON.parse(readFileSync(new URL(`../src/checkable/${bank}`, import.meta.url), "utf8")));

  return shuffled(doc.items, mulberry32(20260926)).map((i) => ({ id: i.id, request: { state: i.state, questions: i.questions } as Payload }));
}

if (import.meta.main) {
  await import("../../../experience-prototypes/scripts/credentials");

  const { dryRun, apiKey } = recorderKey();
  // Optional: another bank in src/checkable/ and its log name, e.g. judgement-bank.json judgement.
  const [bank = "bank.json", log = "checkable"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const all = jobs(bank);
  const result = await record(all, jevEndpoint({ apiKey, maxAttempts: 1, deadlineMs: 20_000 }), {
    out: outFor(log),
    dryRun,
    failFast: Infinity,
    retry: waitOutBusy,
    gapMs: 700,
    okRow: attemptRow,
    errorRow: attemptErrorRow,
    onStart: (todo, skipped) => console.log(`${all.length} items, ${skipped} recorded, ${todo} to ask.`),
    onJob: (s) => {
      if (s.jobs % 25 === 0) console.log(`${s.jobs} / ${s.todo}`);
    },
  });

  if (!dryRun) console.log(result.stopped ? `Stopped: ${result.stopped}` : "Done.");
}
