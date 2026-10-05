/**
 * Records Jev's answers for every puzzle × sentence (and the referee's for every sentence), so
 * Fool Jev works without a key. One request at a time; resumes from what is already recorded;
 * stops at the request cap. `--pilot` records four requests to check the referee first;
 * `--dry-run` lists the requests and sends nothing.
 *
 *   bun packages/arena/src/fool/record.ts [--pilot] [--dry-run]
 */
import type { Payload } from "../../../jev-client/src/index";
import { jevEndpoint } from "../../../jev-client/src/endpoints";
import { jevErrorRow, jevRow, listPrice, noRetry, record, recorderKey, type Job } from "../../../jev-client/src/recorder";
import { answerRequest, cheatFor, PUZZLES, refereeRequest, sentencesFor } from "./model";

const CAP = 200;

export const out = new URL("../../recordings/fool.jsonl", import.meta.url);

export const jobs = (): Job[] =>
  PUZZLES.flatMap((p) =>
    sentencesFor(p.id).flatMap((s): Job[] => [
      { id: `answer:${p.id}:${s}`, request: answerRequest(p, s) as Payload },
      ...(s ? [{ id: `referee:${p.id}:${s}`, request: refereeRequest(p, s) as Payload }] : []),
    ]),
  );

export function pilot(all: Job[]) {
  const madrid = PUZZLES[0];
  const ids = [
    `referee:${madrid.id}:Most people say no.`,
    `referee:${madrid.id}:${cheatFor(madrid.id)}`,
    `referee:${madrid.id}:It's raining in London.`,
    `referee:${madrid.id}:I'm pretty sure the answer is no.`,
    `referee:capital:${cheatFor("capital")}`,
    `referee:capital:I'm pretty sure the answer is no.`,
    `answer:${madrid.id}:Most people say no.`,
  ];

  return all.filter((j) => ids.includes(j.id));
}

if (import.meta.main) {
  await import("../../../../experience-prototypes/scripts/credentials");

  const { dryRun, apiKey } = recorderKey();
  const all = jobs();
  const result = await record(process.argv.includes("--pilot") ? pilot(all) : all, jevEndpoint({ apiKey, maxAttempts: 3, deadlineMs: 20_000 }), {
    out,
    dryRun,
    limit: CAP,
    failFast: Infinity,
    spend: (reply) => listPrice(reply.raw!) ?? 0,
    retry: noRetry,
    okRow: jevRow,
    errorRow: jevErrorRow,
  });

  if (!dryRun) console.log(`Sent ${result.sent} requests, list-price cost $${result.spentUsd.toFixed(5)}.`);
}
