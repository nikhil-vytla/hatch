/**
 * Records the pixels lane of Eyes against state: a local vision-language model plays Snake from
 * screenshots, one prefill per move (vlm_server.py), on the same seeds as the facts lane.
 * Free and local (Apple silicon, MLX-VLM); no paid calls. Resumes from what is recorded and
 * stops after 5 consecutive request failures.
 *
 *   bun live-worlds/eyes/record.ts [--url http://127.0.0.1:30100] [--seeds 101-120,7,19,42] [--prompt v1|v2] [--name qwen3-vl-4b]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { greedy, initial, type State } from "../../local-models-and-games/arcade/engine";
import { png } from "./frame";
import { apply, DIRECTIONS, LABELS, pick, PROMPTS, relative, type Direction, type FrameRecord } from "./model";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);

  return i > 0 ? process.argv[i + 1] : d;
};

const url = arg("url", "http://127.0.0.1:30100");
const prompt = arg("prompt", "v1") as keyof typeof PROMPTS;
const out = new URL(`./recordings/${arg("name", "qwen3-vl-4b")}.${prompt}.jsonl`, import.meta.url);
const seeds = arg("seeds", "101-120,7,19,42")
  .split(",")
  .flatMap((part) => {
    const [a, b] = part.split("-").map(Number);

    return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
  });

const health = await fetch(`${url}/health`).then((r) => r.json());

if (!health.ok) throw Error(`Scorer not healthy at ${url}`);

const model: string = health.model;
const server = `mlx-vlm on Apple M4 Max (local); one prefill per move, softmax over A-D logits`;
const done = new Set(
  existsSync(out)
    ? readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .map((r: FrameRecord) => `${r.seed}:${r.tick}`)
    : [],
);

let failures = 0;

for (const seed of seeds) {
  let s: State = initial("snake", seed);

  while (s.status === "playing" && s.tick < 90) {
    const key = `${seed}:${s.tick}`;
    const frame = png(s);

    if (done.has(key)) {
      // Replay the recorded choice so the game reaches the next unrecorded frame.
      const r: FrameRecord = readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((x: FrameRecord) => x.seed === seed && x.tick === s.tick);

      s = apply(s, r.move);
      continue;
    }

    let res: { probabilities: Record<string, number>; label_mass: number; ms: number; prompt_tokens: number };

    try {
      const r = await fetch(`${url}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify({ image_png_b64: Buffer.from(frame.bytes).toString("base64"), question: PROMPTS[prompt], labels: LABELS }),
      });

      res = await r.json();

      if (!r.ok) throw Error(JSON.stringify(res));

      failures = 0;
    } catch (e) {
      failures++;
      console.error(`seed ${seed} tick ${s.tick}: ${e}`);

      if (failures >= 5) throw Error("5 consecutive failures; stopping");

      continue;
    }

    const probabilities = Object.fromEntries(DIRECTIONS.map((d, i) => [d, res.probabilities[LABELS[i]]])) as Record<Direction, number>;
    const chosen = pick(probabilities);
    const move = relative(s.heading!, chosen);
    const row: FrameRecord = {
      seed,
      prompt,
      tick: s.tick,
      frame_sha256: frame.sha256,
      model,
      server,
      probabilities,
      label_mass: res.label_mass,
      ms: Math.round(res.ms * 10) / 10,
      prompt_tokens: res.prompt_tokens,
      chosen,
      move,
      greedy: greedy(s),
      at: new Date().toISOString(),
    };

    appendFileSync(out, JSON.stringify(row) + "\n");
    s = apply(s, move);
  }

  console.log(`seed ${seed}: ${s.status} at move ${s.tick}, score ${s.score}`);
}
