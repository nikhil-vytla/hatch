/**
 * Records the vision lane of Count with me: a local vision-language model answers the typed
 * questions (count bin, more than N, even) about each full-size image, one prefill per question
 * (vlm_server.py), softmax over the label tokens' logits. Free and local (Apple silicon,
 * MLX-VLM). Resumes from what is recorded; stops after 5 consecutive failures.
 *
 *   bun live-worlds/count/record-vlm.ts --cache DIR [--url http://127.0.0.1:30110] [--name qwen3-vl-4b] [--limit N]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vlmQuestions, type Item } from "./model";

const arg = (name: string, d?: string) => {
  const i = process.argv.indexOf(`--${name}`);

  return i > 0 ? process.argv[i + 1] : d;
};

const url = arg("url", "http://127.0.0.1:30110")!;
const cache = arg("cache");

if (!cache) throw Error("Pass --cache, the directory choose.py kept full-size images in.");

const limit = Number(arg("limit", "1e9"));
const out = new URL(`./recordings/${arg("name", "qwen3-vl-4b")}.jsonl`, import.meta.url);
const { items } = JSON.parse(readFileSync(new URL("./items.json", import.meta.url), "utf8")) as { items: Item[] };
const health = await fetch(`${url}/health`).then((r) => r.json());

if (!health.ok) throw Error(`Scorer not healthy at ${url}`);

const server = "mlx-vlm on Apple M4 Max (local); one prefill per question, softmax over the label tokens' logits";
const done = new Set(
  existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .map((r) => `${r.id}:${r.question}`)
    : [],
);

let failures = 0;
let sent = 0;

for (const item of items.slice(0, limit)) {
  const image = readFileSync(join(cache, item.file)).toString("base64");

  for (const q of vlmQuestions(item)) {
    if (done.has(`${item.id}:${q.key}`)) continue;

    try {
      const r = await fetch(`${url}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({ image_png_b64: image, question: q.question, labels: q.labels }),
      });
      const res = await r.json();

      if (!r.ok) throw Error(JSON.stringify(res));

      failures = 0;
      sent++;
      appendFileSync(
        out,
        JSON.stringify({
          id: item.id,
          question: q.key,
          model: health.model,
          server,
          probabilities: res.probabilities,
          labelMass: res.label_mass,
          ms: res.ms,
          promptTokens: res.prompt_tokens,
          at: new Date().toISOString(),
        }) + "\n",
      );
    } catch (e) {
      failures++;
      console.error(`${item.id} ${q.key}: ${e}`);

      if (failures >= 5) throw Error("5 consecutive failures; stopping");
    }
  }
}

const after = await fetch(`${url}/health`).then((r) => r.json());

console.log(`Recorded ${sent} answers. Server peak memory ${after.peak_gb} GB.`);
