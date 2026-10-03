/**
 * PROTOTYPE — runs the pipeline on the scripted café clip, scores it against the script, and
 * writes the recorded result the scene replays by default.
 *
 *   bun live-worlds/who-said-that/record.proto.ts <clip-dir> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { hear } from "./pipeline.proto";
import { ASR_MODEL, nodeModels, readWav, TEXT_MODEL } from "./node-models.proto";
import { SPEAKER_MODEL } from "./speaker.proto";

type Truth = { tags: { me: [number, number]; priya: [number, number] }; lines: { who: string; text: string; start: number; end: number }[] };

const [dir, outPath, voiceArg] = process.argv.slice(2);
const useSpeaker = voiceArg !== "mfcc";
const truth: Truth = JSON.parse(readFileSync(`${dir}/cafe.truth.json`, "utf8"));
const audio = readWav(`${dir}/cafe.wav`);
const t0 = performance.now();
const models = await nodeModels({ speaker: useSpeaker });
const loadMs = performance.now() - t0;
const r = await hear(audio, { me: truth.tags.me, friend: truth.tags.priya }, models, (d, n) => process.stdout.write(`\r${d}/${n}`));

console.log();

// Each detected segment's true speaker is the scripted line it overlaps most.
const expected = r.lines.map((l) => {
  let best = { who: "else", overlap: 0 };

  for (const t of truth.lines) {
    const ov = Math.min(l.end, t.end) - Math.max(l.start, t.start);

    if (ov > best.overlap) best = { who: t.who === "me" ? "me" : t.who === "priya" ? "friend" : "else", overlap: ov };
  }

  return best.who;
});
const correct = r.lines.filter((l, i) => l.answers.who === expected[i]).length;
const confusion: Record<string, Record<string, number>> = {};

r.lines.forEach((l, i) => {
  confusion[expected[i]] ??= {};
  confusion[expected[i]][l.answers.who] = (confusion[expected[i]][l.answers.who] ?? 0) + 1;
});

// A voice-only baseline: the fingerprint's top guess, ignoring topic and continuation.
const voiceOnly = r.lines.filter((l, i) => {
  const v = l.answers.voice;
  const g = v.me >= v.friend && v.me >= v.else ? "me" : v.friend >= v.else ? "friend" : "else";

  return g === expected[i];
}).length;
// Lines missed entirely: scripted lines no segment was matched to.
const covered = new Set(
  r.lines.map((l) => truth.lines.findIndex((t) => Math.min(l.end, t.end) - Math.max(l.start, t.start) > 0.2)),
);
const summary = {
  segments: r.lines.length,
  scripted: truth.lines.length,
  scriptedHeard: [...covered].filter((i) => i >= 0).length,
  correct,
  accuracy: +(correct / r.lines.length).toFixed(3),
  voiceOnlyAccuracy: +(voiceOnly / r.lines.length).toFixed(3),
  confusion,
  ms: { load: Math.round(loadMs), ...Object.fromEntries(Object.entries(r.ms).map(([k, v]) => [k, Math.round(v)])) },
  perSegmentAsrMs: Math.round(r.ms.asr / Math.max(1, r.lines.length)),
};

console.log(JSON.stringify(summary, null, 1));
writeFileSync(
  outPath,
  JSON.stringify({
    clip: "cafe",
    models: { asr: ASR_MODEL, text: TEXT_MODEL, voice: useSpeaker ? SPEAKER_MODEL : "MFCC + pitch fingerprint (no model)" },
    recordedAt: new Date().toISOString(),
    tags: { me: truth.tags.me, friend: truth.tags.priya },
    summary,
    expected,
    lines: r.lines.map(({ voice: _v, meaning: _m, ...l }) => ({ ...l, answers: { ...l.answers, voice: Object.fromEntries(Object.entries(l.answers.voice).map(([k, v]) => [k, +v.toFixed(3)])) } })),
  }) + "\n",
);
