/**
 * Separates "can't see" from "can't decide": asks the vision model two yes/no questions about
 * frames from the greedy rule's games (is the food above the head? to its right?), where the
 * answer is known from the game state. Writes recordings/<name>.perception.jsonl.
 *
 *   bun live-worlds/eyes/perception.ts [--url http://127.0.0.1:30100] [--name qwen3-vl-8b]
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { greedy, initial, step, type State } from "../../local-models-and-games/arcade/engine";
import { png } from "./frame";

const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);

  return i > 0 ? process.argv[i + 1] : d;
};

const url = arg("url", "http://127.0.0.1:30100");
const out = new URL(`./recordings/${arg("name", "qwen3-vl-8b")}.perception.jsonl`, import.meta.url);
const health = await fetch(`${url}/health`).then((r) => r.json());

export const PERCEPTION = {
  above: "Snake game board. The black square is the snake's head and the red dot is food. Is the red dot higher up in the image than the black square?\nA: yes\nB: no\nAnswer with one letter.",
  right: "Snake game board. The black square is the snake's head and the red dot is food. Is the red dot further to the right in the image than the black square?\nA: yes\nB: no\nAnswer with one letter.",
} as const;

writeFileSync(out, "");

let n = 0;

for (let seed = 101; seed <= 110; seed++) {
  let s: State = initial("snake", seed);

  while (s.status === "playing" && s.tick < 90) {
    const head = s.snake![0];
    const truth = { above: s.food!.y < head.y, right: s.food!.x > head.x };
    const sameRow = s.food!.y === head.y;
    const sameCol = s.food!.x === head.x;

    if (s.tick % 3 === 0) {
      const frame = png(s);

      for (const q of ["above", "right"] as const) {
        if ((q === "above" && sameRow) || (q === "right" && sameCol)) continue;

        const r = await fetch(`${url}/score`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Connection: "close" },
          body: JSON.stringify({ image_png_b64: Buffer.from(frame.bytes).toString("base64"), question: PERCEPTION[q], labels: ["A", "B"] }),
        }).then((x) => x.json());
        const yes = r.probabilities.A;

        appendFileSync(out, JSON.stringify({ seed, tick: s.tick, frame_sha256: frame.sha256, model: health.model, question: q, truth: truth[q], p_yes: yes, right: yes >= 0.5 === truth[q], ms: r.ms }) + "\n");
        n++;
      }
    }

    s = step(s, greedy(s));
  }
}

console.log(`${n} perception questions recorded`);
