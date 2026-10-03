/**
 * Records each scenario's signals (segments, words, voice and meaning embeddings, loudness) with
 * the same models the browser runs, so the scene can replay them without a download.
 *
 *   bun live-worlds/who-said-that/record-signals.ts <dir of scenario WAVs from data/build.py> [out dir]
 *
 * Writes <id>.signals.json to experience-prototypes/public/who-said-that/ unless an out dir is given.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeModels, readWavChannels, ASR_MODEL, TEXT_MODEL } from "./node-models";
import { compact, listen, MAX_SEGMENT } from "./signals";
import { SPEAKER_MODEL } from "./speaker";

const dir = process.argv[2];

if (!dir) throw new Error("Pass the folder of scenario WAVs written by data/build.py.");

const out = process.argv[3] ?? new URL("../../experience-prototypes/public/who-said-that/", import.meta.url).pathname;
const models = await nodeModels();

for (const f of readdirSync(dir).filter((f) => f.endsWith(".wav"))) {
  const id = f.replace(/\.wav$/, "");
  const audio = readWavChannels(join(dir, f));
  const t0 = performance.now();
  const heard = await listen(audio, models);
  const ms = Math.round(performance.now() - t0);

  writeFileSync(
    join(out, `${id}.signals.json`),
    JSON.stringify({
      id,
      recorded: new Date().toISOString().slice(0, 10),
      models: { asr: ASR_MODEL, text: TEXT_MODEL, voice: SPEAKER_MODEL },
      maxSegment: MAX_SEGMENT,
      ms,
      heard: compact(heard),
    }),
  );
  console.log(id, heard.length, "segments", ms, "ms");
}
