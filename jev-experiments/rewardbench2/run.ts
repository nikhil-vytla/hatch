import {
  readFileSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { evaluate } from "../experience-prototypes/scripts/local-model";
import { writeRecord, encodeRecord } from "../experience-prototypes/scripts/records";
import {
  DATASET_REVISION,
  SCORER_REVISION,
  RUBRIC,
  pack,
  instructions,
  batchPayload,
  batches,
  type Case,
} from "./protocol";
import { summarize, completed } from "./metrics";
import { preparePublicResult } from "./publication";
import { publicationSourceFromRecord } from "./publication-source";

const dir = import.meta.dir,
  cache = resolve(dir, "../.cache/rewardbench2"),
  work = resolve(cache, "completed-v2"),
  requestsDir = resolve(cache, "requests-v2");
mkdirSync(work, { recursive: true });
mkdirSync(requestsDir, { recursive: true });
const protocolHash = createHash("sha256")
  .update(
    JSON.stringify({
      version: 2,
      model: "typesafe-ai/jev",
      rubric: RUBRIC,
      template: batchPayload([
        {
          row: pack({
            id: "fixture",
            subset: "Focus",
            prompt: "prompt",
            chosen: ["candidate"],
            rejected: [],
            models: ["hidden"],
          }),
          candidate: {
            label: "A",
            text: "candidate",
            model: "hidden",
            chosen: true,
          },
        },
      ]),
      ties: instructions("Ties"),
    }),
  )
  .digest("hex");
const raw = JSON.parse(readFileSync(resolve(cache, "dataset.json"), "utf8"));
let rows: Case[] = raw.map(pack);
const caseKey = (row: Case) => `${row.subset}:${row.id}`;
const casePath = (row: Case) =>
  resolve(work, `${encodeURIComponent(caseKey(row))}.json`);
if (new Set(rows.map(caseKey)).size !== rows.length)
  throw Error("Duplicate dataset case key");
const limit = Number(process.env.RB2_LIMIT ?? 0);
if (limit) rows = rows.slice(0, limit);
for (let i = 0; i < rows.length; i++) {
  const path = casePath(rows[i]);
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (
      saved.protocol_hash !== protocolHash ||
      saved.row.input_hash !== rows[i].input_hash
    )
      throw Error("Cached input or protocol mismatch");
    rows[i] = saved.row;
  }
}
const requests: any[] = readdirSync(requestsDir)
  .filter((n) => n.endsWith(".json"))
  .map((n) => JSON.parse(readFileSync(resolve(requestsDir, n), "utf8")));
const runMetaPath = resolve(cache, "run-v2.json");
const runMeta = existsSync(runMetaPath)
  ? JSON.parse(readFileSync(runMetaPath, "utf8"))
  : {
      id: `rewardbench2-${randomUUID()}`,
      created: new Date().toISOString(),
      protocol_hash: protocolHash,
    };
if (runMeta.protocol_hash !== protocolHash)
  throw Error("Run protocol changed; use a new cache directory");
writeFileSync(runMetaPath, JSON.stringify(runMeta));
const publish = () => {
  const result = {
    title: "RewardBench 2",
    model: "typesafe-ai/jev",
    rows: structuredClone(rows),
    metrics: summarize(rows),
    requests: [...requests].sort((a, b) => a.at.localeCompare(b.at)),
    provenance: {
      name: "RewardBench 2",
      organization: "Allen Institute for AI (Ai2)",
      revision: DATASET_REVISION,
      url: `https://huggingface.co/datasets/allenai/reward-bench-2/tree/${DATASET_REVISION}`,
      paper_url: "https://arxiv.org/abs/2506.01937",
      license: "ODC-BY",
      parquet_sha256:
        "c8ec60efbd75d2f9dcba4121e6101f7a6015abc38a34e034ae2c7ae886265958",
      scorer_revision: SCORER_REVISION,
      scorer_url: `https://github.com/allenai/reward-bench/blob/${SCORER_REVISION}/rewardbench/utils.py#L1033`,
      population: 1865,
      split: "test",
      sampling: limit
        ? `First ${limit} cases, integration check only`
        : "Full test split, no case exclusions",
      labels:
        "Published chosen/rejected labels. Factuality uses model filtering; Precise IF uses executable verifiers; Math uses majority voting; Safety uses model judgments and rubrics; Focus uses system-prompt variations; Ties uses manual verification.",
      response_models:
        "Upstream responses from multiple models; per-answer model names are supplied with each case. No answers were generated for this run.",
    },
    protocol: {
      version: 2,
      hash: protocolHash,
      candidate_order:
        "SHA-256 shuffle keyed by seed 42, case ID, and original candidate index",
      labels_visible_to_jev: false,
      models_visible_to_jev: false,
      scoring:
        "One independent typed Score question per answer. Each question contains only its own prompt and candidate, serialized as structured JSON. Shared state contains the evaluation policy only. Questions are batched under 90 KB and 128 questions; Jev documents that each question is evaluated independently. Returned 0–9 scores are shifted to 1–10.",
      isolation_source: "https://docs.typesafe.ai/primitives",
      rubric: RUBRIC,
      instructions: instructions("default"),
      ties_instructions: instructions("Ties"),
      independent_judge: "None. Dataset labels determine benchmark scores.",
    },
    content_note:
      "Safety cases deliberately contain harmful material. Other subsets may contain sensitive topics or incorrect and offensive answers. Original text is used for evaluation; reviewed omissions affect public display only. A preferred label is not an endorsement or a guarantee of truth.",
  };
  preparePublicResult(result);
  writeRecord(resolve(dir, "results.jsonl"), publicationSourceFromRecord(encodeRecord({
    manifest: {
      experiment: "rewardbench2",
      ...runMeta,
      updated: new Date().toISOString(),
      status: rows.every(completed) ? "complete" : "partial",
    },
    result,
  })));
};
const saveCase = (row: Case) => {
  const path = casePath(row);
  writeFileSync(
    path + ".tmp",
    JSON.stringify({ protocol_hash: protocolHash, row }),
  );
  renameSync(path + ".tmp", path);
};
publish();
let lastRequest = 0,
  notBefore = 0;
for (let sweep = 0; sweep < 4; sweep++) {
  const requestOrder = (r: Case) =>
    createHash("sha256").update(caseKey(r)).digest("hex");
  const groups = batches(
    rows
      .filter((r) => !completed(r))
      .sort((a, b) => requestOrder(a).localeCompare(requestOrder(b))),
  );
  if (!groups.length) break;
  console.log(
    JSON.stringify({
      sweep,
      batches: groups.length,
      completed: rows.filter(completed).length,
    }),
  );
  for (const jobs of groups) {
    await Bun.sleep(
      Math.max(
        0,
        Number(process.env.RB2_INTERVAL_MS ?? 6500) -
          (Date.now() - lastRequest),
        notBefore - Date.now(),
      ),
    );
    lastRequest = Date.now();
    const requestId = randomUUID(),
      before = Date.now(),
      body = batchPayload(jobs);
    let record: any;
    const quotaObservations: any[] = [];
    let providerModel: string | undefined, usage: unknown;
    try {
      const answer = await evaluate(body, {
        deadlineMs: 300000,
        wait: (ms) => Bun.sleep(ms + 750),
        fetcher: (async (input, init) => {
          const response = await fetch(input, init);
          const quota = Object.fromEntries(
            [...response.headers].filter(
              ([k]) => k.startsWith("x-ratelimit-") || k === "retry-after",
            ),
          );
          quotaObservations.push({ status: response.status, ...quota });
          const reset = (name: string) => {
            const value = quota[name] ?? "";
            return /^\d+(\.\d+)?s$/.test(value) ? parseFloat(value) * 1000 : 0;
          };
          if (Number(quota["x-ratelimit-remaining-requests"]) <= 1)
            notBefore = Math.max(
              notBefore,
              Date.now() + reset("x-ratelimit-reset-requests") + 750,
            );
          if (
            Number(quota["x-ratelimit-remaining-tokens"]) <
            Buffer.byteLength(JSON.stringify(body)) / 2.5
          )
            notBefore = Math.max(
              notBefore,
              Date.now() + reset("x-ratelimit-reset-tokens") + 750,
            );
          if (response.ok) {
            try {
              const raw = await response.clone().json();
              providerModel =
                typeof raw.model === "string" ? raw.model : undefined;
              usage = {
                input_tokens: raw.usage?.input_tokens,
                output_tokens: raw.usage?.output_tokens,
              };
            } catch {
              /* The gateway validator handles malformed JSON. */
            }
          }
          return response;
        }) as typeof fetch,
      });
      jobs.forEach(({ candidate }, i) => {
        const a = answer.answers[`q${i}`];
        candidate.score = Number(a.value) + 1;
        candidate.confidence = a.confidence;
        candidate.probabilities = a.probabilities;
      });
      record = {
        id: requestId,
        status: "completed",
        question_count: jobs.length,
        latency_ms: Date.now() - before,
        cost_usd: answer.cost_usd,
        attempts: answer.attempts,
        at: new Date().toISOString(),
      };
    } catch (e: any) {
      record = {
        id: requestId,
        status: "unavailable",
        question_count: jobs.length,
        attempts: e.attempts ?? [],
        at: new Date().toISOString(),
      };
      if ([400, 401, 403].includes(e.status)) throw e;
    }
    record.quota_observations = quotaObservations;
    record.provider_model = providerModel;
    record.usage = usage;
    requests.push(record);
    writeFileSync(
      resolve(requestsDir, `${requestId}.json`),
      JSON.stringify(record),
    );
    for (const row of new Set(jobs.map((j) => j.row))) {
      row.request_ids = [...(row.request_ids ?? []), requestId];
      row.status = row.candidates.every((c) => Number.isFinite(c.score))
        ? "completed"
        : "pending";
      saveCase(row);
    }
    if (requests.length % 5 === 0 || rows.every(completed)) {
      publish();
      console.log(
        JSON.stringify({
          completed: rows.filter(completed).length,
          total: rows.length,
          requests: requests.length,
          sweep,
          at: new Date().toISOString(),
        }),
      );
    }
  }
  publish();
}
publish();
console.log(
  JSON.stringify(
    { complete: rows.every(completed), metrics: summarize(rows) },
    null,
    2,
  ),
);
if (!rows.every(completed)) process.exitCode = 1;
