/**
 * PROTOTYPE diagnostic on real voices (LibriSpeech test-clean, CC BY 4.0): each speaker's first
 * utterance is their tag; the other three must be matched to the right speaker out of eight.
 */
import { readFileSync } from "node:fs";
import { nodeSpeaker, readWav } from "./node-models.proto";
import { embedVoice } from "./speaker.proto";
import { cosine, fingerprint, standardise } from "./voice.proto";

const dir = process.argv[2];
const rows = JSON.parse(readFileSync(`${dir}/multi.json`, "utf8")) as { file: string; speaker: number }[];
const audio = rows.map((r) => readWav(`${dir}/${r.file}`));
const whole = (x: Float32Array) => ({ start: 0, end: x.length / 16000 });
const run = await nodeSpeaker();
const cam: number[][] = [];

for (const x of audio) cam.push(await embedVoice(run, x, whole(x)));

const mfcc = standardise(audio.map((x) => fingerprint(x, whole(x))));

for (const [name, vs] of [["mfcc", mfcc], ["cam++", cam]] as const) {
  const tags = new Map<number, number[]>();
  let right = 0;
  let total = 0;

  rows.forEach((r, i) => {
    if (!tags.has(r.speaker)) {
      tags.set(r.speaker, vs[i]);

      return;
    }

    let best = { s: -1, sim: -Infinity };

    for (const [s, t] of tags) {
      const sim = cosine(vs[i], t);

      if (sim > best.sim) best = { s, sim };
    }

    total++;

    if (best.s === r.speaker) right++;
  });

  console.log(name, `speaker ID ${right}/${total} (${Math.round((100 * right) / total)}%)`);
}
