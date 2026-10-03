/**
 * PROTOTYPE diagnostic: same-speaker against different-speaker similarity over the exact
 * scripted lines, for the MFCC fingerprint and for CAM++. Higher "gap" separates voices better.
 */
import { readFileSync } from "node:fs";
import { nodeSpeaker, readWav } from "./node-models.proto";
import { embedVoice } from "./speaker.proto";
import { cosine, fingerprint, standardise } from "./voice.proto";

const dir = process.argv[2];
const truth = JSON.parse(readFileSync(`${dir}/cafe.truth.json`, "utf8")) as { lines: { who: string; start: number; end: number }[] };
const audio = readWav(`${dir}/cafe.wav`);
const run = await nodeSpeaker();
const cam: number[][] = [];

for (const l of truth.lines) cam.push(await embedVoice(run, audio, l));

const mf = standardise(truth.lines.map((l) => fingerprint(audio, l)));

for (const [name, vs] of [["mfcc", mf], ["cam++", cam]] as const) {
  const same: number[] = [];
  const diff: number[] = [];

  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++) (truth.lines[i].who === truth.lines[j].who ? same : diff).push(cosine(vs[i], vs[j]));

  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

  console.log(name, "same", avg(same).toFixed(3), "different", avg(diff).toFixed(3), "gap", (avg(same) - avg(diff)).toFixed(3));
}
