/**
 * Records Jev's answer for every profile, for one preset (the £500 scam) and its correction, so
 * the page can show the same rumour spreading on Jev without a key. Local only; uses the existing
 * credentials helper and never runs in the browser. Caps: 300 requests, $0.10. Not resumable:
 * every run appends a fresh set; any failure stops it.
 *
 *   cd jev-experiments/experience-prototypes && bun ../live-worlds/rumour/record.ts [--dry-run]
 */
import { jevEndpoint, type JevResult, type Reply } from "../../packages/jev-client/src/endpoints";
import { JEV_USD_PER_INPUT_TOKEN } from "../../packages/jev-client/src/price";
import { record, recorderKey, type Attempt, type Job } from "../../packages/jev-client/src/recorder";
import type { Payload } from "../../packages/jev-client/src/wire";
import { allProfiles, jevRequest, type MessageKind } from "./profiles";
import { PRESETS } from "./presets";

const PRESET = "scam";
const MAX_REQUESTS = 300;
const MAX_USD = 0.1;

export const out = new URL("./jev-scam.jsonl", import.meta.url);

// This recording priced tokens per token (not per million), so its costs keep that rounding.
const cost = (tokens: number | null) => (tokens === null ? null : tokens * JEV_USD_PER_INPUT_TOKEN);

export type RumourJob = Job & { kind: MessageKind; keys: string[] };

/** 100 profiles per request: the rumour, then its correction. */
export function jobs(): RumourJob[] {
  const preset = PRESETS.find((p) => p.id === PRESET);

  if (!preset) throw Error(`No preset ${PRESET}.`);

  return (["rumour", "counter"] as MessageKind[]).flatMap((kind) => {
    const profiles = allProfiles(kind);

    return Array.from({ length: Math.ceil(profiles.length / 100) }, (_, b) => {
      const batch = profiles.slice(b * 100, b * 100 + 100);

      return {
        id: `${kind}:${b * 100}`,
        kind,
        keys: batch.map((p) => p.key),
        request: jevRequest(batch, kind, kind === "rumour" ? preset.text : preset.counter, kind === "counter" ? preset.text : null, preset.place) as Payload,
      };
    });
  });
}

/** The rows carry no id or status: the preset, the kind, the receipt and each profile's answer. */
export function okRow(job: RumourJob, reply: Reply<JevResult>, { at }: Attempt) {
  const r = reply.raw!;

  return {
    preset: PRESET,
    kind: job.kind,
    at,
    model: r.model,
    servedBy: r.served_by,
    generationId: r.generation_id,
    latencyMs: r.latency_ms,
    inputTokens: r.usage?.input_tokens ?? null,
    costUsd: cost(r.usage?.input_tokens ?? null),
    questions: job.keys.length,
    answers: Object.fromEntries(job.keys.map((key, j) => [key, r.answers[`p${j}`] ?? null])),
  };
}

if (import.meta.main) {
  await import("../../experience-prototypes/scripts/credentials");

  const { dryRun, apiKey } = recorderKey();
  const result = await record(jobs(), jevEndpoint({ apiKey, maxAttempts: 4, deadlineMs: 40_000 }), {
    out,
    dryRun,
    resume: false,
    limit: MAX_REQUESTS,
    maxUsd: MAX_USD,
    spend: (reply) => cost(reply.raw!.usage?.input_tokens ?? null) ?? 0,
    retry: () => "throw",
    okRow,
    // A failure is not logged; it stops the run.
    errorRow: () => null,
    onJob: (_s, job) => console.log(`${job.id}: ${job.keys.length} profiles`),
  });

  if (!dryRun) {
    if (result.stopped) throw Error(`Cap reached (${result.stopped}).`);
    console.log(`Sent ${result.sent} requests, list-price cost $${result.spentUsd.toFixed(5)}.`);
  }
}
