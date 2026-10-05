/**
 * Records Jev's answers to the three text questions for every line of every published scenario,
 * and the two whole-transcript count questions, so the page can show a recorded Jev lane. Jev only
 * sees the recognised words; voice, loudness and microphone stay with code.
 *
 *   bun live-worlds/who-said-that/record-jev.ts [--pilot] [--cap <usd>] [--dry-run]
 *
 * One request at a time, resuming from recordings/jev.jsonl. Stops at the spending cap (list
 * price; `--cap <usd>` also caps this run) or after five failures in a row. A line is asked again
 * when its request has changed (re-recorded signals). `--pilot` sends the first 10 requests only.
 * Then writes experience-prototypes/public/who-said-that/<id>.jev.json for every scenario whose
 * lines are all answered.
 *
 * Evaluation only: these answers are shown, never trained on (TypeSafe MCA §2.3(b)).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { jevEndpoint, type JevResult, type Reply } from "../../packages/jev-client/src/endpoints";
import { readRows, type RecordedRow } from "../../packages/jev-client/src/recordings";
import { jevErrorRow, listPrice, noRetry, record, recorderKey, type Attempt, type Job } from "../../packages/jev-client/src/recorder";
import type { Payload } from "../../packages/jev-client/src/wire";
import { fromJev, jevCountRequest, jevRequest, LOOKBACK, type TextAnswers } from "./questions";
import type { Heard } from "./signals";

const CAP_USD = 0.25;
const PILOT = 10;

const pub = new URL("../../experience-prototypes/public/who-said-that/", import.meta.url).pathname;
export const out = new URL("./recordings/jev.jsonl", import.meta.url).pathname;

type Row = RecordedRow & { request?: Payload; answers?: Record<string, { value?: unknown; probabilities?: Record<string, number> | null }> };

const scenarioIds = (): string[] => JSON.parse(readFileSync(`${pub}scenarios.json`, "utf8")).map((s: { id: string }) => s.id);
const heardOf = (sid: string): Heard[] => JSON.parse(readFileSync(`${pub}${sid}.signals.json`, "utf8")).heard;

/** Every scenario's lines, then its counts, in order. */
export const jobs = (): Job[] =>
  scenarioIds().flatMap((sid) => {
    const heard = heardOf(sid);

    return [
      ...heard.map((_, i) => ({ id: `${sid}:${i}`, request: jevRequest(heard, i) as unknown as Payload })),
      { id: `${sid}:counts`, request: jevCountRequest(heard) as unknown as Payload },
    ];
  });

/** An answer is reused only for the same request: re-recorded signals change the lines. */
const current = (answered: Map<string, RecordedRow>, job: Job) => {
  const row = answered.get(job.id) as Row | undefined;

  return row && JSON.stringify(row.request) === JSON.stringify(job.request) ? row : undefined;
};

export function okRow(job: Job, reply: Reply<JevResult>, { at }: Attempt) {
  const r = reply.raw!;

  return { id: job.id, at, status: "ok", request: job.request, answers: r.answers, latencyMs: r.latency_ms, inputTokens: r.usage?.input_tokens ?? null, costUsd: listPrice(r), servedBy: r.served_by, model: r.model };
}

if (import.meta.main) {
  await import("../../experience-prototypes/scripts/credentials");

  const { dryRun, apiKey } = recorderKey();
  const capAt = process.argv.indexOf("--cap");
  const RUN_CAP_USD = capAt >= 0 ? Number(process.argv[capAt + 1]) : Infinity;
  const before = readRows(out).reduce((s, r) => s + (r.costUsd ?? 0), 0);
  const all = jobs();
  const result = await record(all, jevEndpoint({ apiKey, maxAttempts: 3, deadlineMs: 20_000 }), {
    out,
    dryRun,
    skip: (job, answered) => current(answered, job) !== undefined,
    limit: process.argv.includes("--pilot") ? PILOT : undefined,
    maxUsd: CAP_USD,
    spentUsd: before,
    stop: (s) => (s.spentUsd - before >= RUN_CAP_USD ? `this run's $${RUN_CAP_USD} cap` : null),
    spend: (reply) => listPrice(reply.raw!) ?? 0,
    failFast: 5,
    retry: noRetry,
    okRow,
    errorRow: jevErrorRow,
  });

  if (!dryRun) {
    const byId = new Map(all.map((j) => [j.id, j]));
    const row = (id: string) => current(result.answered, byId.get(id)!);

    for (const sid of scenarioIds()) {
      const heard = heardOf(sid);
      const rows = heard.map((_, i) => row(`${sid}:${i}`));
      const answers: (TextAnswers | null)[] = rows.map((r, i) => (r?.answers ? fromJev(r.answers, Math.min(LOOKBACK, i)) : null));
      const receipts = rows.map((r) => (r ? { latencyMs: r.latencyMs ?? 0, inputTokens: r.inputTokens ?? null, costUsd: r.costUsd ?? null, at: r.at, servedBy: r.servedBy ?? null } : null));
      const count = row(`${sid}:counts`);

      if (answers.every(Boolean)) {
        writeFileSync(
          `${pub}${sid}.jev.json`,
          JSON.stringify({
            id: sid,
            model: row(`${sid}:0`)?.model ?? "typesafe-ai/jev",
            answers,
            receipts,
            counts: count?.answers ?? null,
            countReceipt: count ? { latencyMs: count.latencyMs, inputTokens: count.inputTokens, costUsd: count.costUsd, at: count.at } : null,
          }),
        );
      }

      console.log(sid, `${answers.filter(Boolean).length}/${heard.length} lines`, count ? "counts ok" : "no counts");
    }

    if (result.stopped) console.log(`Stopped: ${result.stopped}.`);
    console.log(`Sent ${result.sent} requests; $${result.spentUsd.toFixed(5)} this run, $${(before + result.spentUsd).toFixed(5)} at list price so far (cap $${CAP_USD}).`);
  }
}
