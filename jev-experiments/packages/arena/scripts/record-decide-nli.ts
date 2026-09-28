/**
 * Records the in-browser zero-shot classifier (src/decide/nli.ts) on Decide's deck, running
 * the same code and model the page runs live. Deterministic, so it simply overwrites.
 *
 *   bun jev-experiments/packages/arena/scripts/record-decide-nli.ts
 */
import { pipeline } from "@huggingface/transformers";
import { writeFileSync } from "node:fs";
import { DECK, requestFor } from "../src/decide/deck";
import { answerWithNli, NLI_MODEL, type ZeroShot } from "../src/decide/nli";

const clf = (await pipeline("zero-shot-classification", NLI_MODEL, {
  dtype: "q8",
})) as unknown as ZeroShot;
const rows: string[] = [];

for (const d of DECK)
  for (const s of d.setups) {
    const started = performance.now();
    const answers = await answerWithNli(clf, requestFor(d, s));

    rows.push(
      JSON.stringify({
        id: `${d.id}:${s.id}`,
        status: "ok",
        latencyMs: Math.round(performance.now() - started),
        model: NLI_MODEL,
        dtype: "q8",
        answers,
      }),
    );
  }

writeFileSync(new URL("../recordings/decide.nli.jsonl", import.meta.url), `${rows.join("\n")}\n`);
console.log(`${rows.length} rows.`);
