/**
 * Records the vision lane of Count with me: a local vision-language model answers the typed
 * questions (count bin, more than N, even) about each full-size image, one prefill per question
 * (vlm_server.py), softmax over the label tokens' logits. Free and local (Apple silicon,
 * MLX-VLM). Resumes from what is recorded; stops after 5 consecutive failures.
 *
 *   bun live-worlds/count/record-vlm.ts --cache DIR [--url http://127.0.0.1:30110] [--name qwen3-vl-4b] [--limit N] [--dry-run]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Endpoint } from "../../packages/jev-client/src/endpoints";
import { record, type Job } from "../../packages/jev-client/src/recorder";
import { vlmQuestions, type Item } from "./model";

export type VlmRequest = { file: string; question: string; labels: string[] };
type Scored = { probabilities: Record<string, number>; label_mass: number; ms: number; prompt_tokens: number };

const items = () => (JSON.parse(readFileSync(new URL("./items.json", import.meta.url), "utf8")) as { items: Item[] }).items;

/** Every question about every image (the first `limit` images), keyed `<image>:<question>`. */
export const jobs = (limit = Infinity): (Job<VlmRequest> & { item: string; key: string })[] =>
  items()
    .slice(0, limit)
    .flatMap((item) =>
      vlmQuestions(item).map((q) => ({ id: `${item.id}:${q.key}`, item: item.id, key: q.key, request: { file: item.file, question: q.question, labels: q.labels } })),
    );

/** The scorer at `url`, reading each image (base64 PNG) from `cache`. */
function scorer(url: string, cache: string): Endpoint<VlmRequest, Scored> {
  let last: { file: string; b64: string } | null = null;

  return {
    label: `vlm_server.py at ${url}`,
    usdPerMTok: 0,
    async ask({ file, question, labels }) {
      if (last?.file !== file) last = { file, b64: readFileSync(join(cache, file)).toString("base64") };

      const r = await fetch(`${url}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({ image_png_b64: last.b64, question, labels }),
      });
      const res = await r.json();

      if (!r.ok) throw Error(JSON.stringify(res));

      return { answers: {}, latencyMs: res.ms, inputTokens: res.prompt_tokens ?? null, costUsd: null, servedBy: url, model: null, raw: res };
    },
  };
}

if (import.meta.main) {
  const arg = (name: string, d?: string) => {
    const i = process.argv.indexOf(`--${name}`);

    return i > 0 ? process.argv[i + 1] : d;
  };

  const dryRun = process.argv.includes("--dry-run");
  const url = arg("url", "http://127.0.0.1:30110")!;
  const cache = arg("cache");

  if (!cache && !dryRun) throw Error("Pass --cache, the directory choose.py kept full-size images in.");

  const out = new URL(`./recordings/${arg("name", "qwen3-vl-4b")}.jsonl`, import.meta.url);
  const health = dryRun ? { ok: true, model: "" } : await fetch(`${url}/health`).then((r) => r.json());

  if (!health.ok) throw Error(`Scorer not healthy at ${url}`);

  const server = "mlx-vlm on Apple M4 Max (local); one prefill per question, softmax over the label tokens' logits";
  const all = jobs(Number(arg("limit", "1e9")));
  const result = await record(all, scorer(url, cache ?? ""), {
    out,
    dryRun,
    // Rows have no status: every row is an answer, keyed by image and question.
    done: () => true,
    idOf: (r) => `${r.id}:${r.question}`,
    failFast: 5,
    retry: () => "next",
    okRow: (job, reply) => {
      const res = reply.raw!;

      return {
        id: job.item,
        question: job.key,
        model: health.model,
        server,
        probabilities: res.probabilities,
        labelMass: res.label_mass,
        ms: res.ms,
        promptTokens: res.prompt_tokens,
        at: new Date().toISOString(),
      };
    },
    // Failures are reported, not recorded.
    errorRow: (job, e) => {
      console.error(`${job.item} ${job.key}: ${e}`);

      return null;
    },
  });

  if (result.stopped) throw Error("5 consecutive failures; stopping");

  if (!dryRun) {
    const after = await fetch(`${url}/health`).then((r) => r.json());

    console.log(`Recorded ${result.ok} answers. Server peak memory ${after.peak_gb} GB.`);
  }
}
