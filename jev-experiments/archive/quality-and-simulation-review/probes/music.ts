// Reproduce the music audit from committed evidence. No model calls or audio.
// Run: bun jev-experiments/quality-and-simulation-review/probes/music.ts
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const records = readFileSync(resolve(root, "results/music.jsonl"), "utf8")
  .trim().split("\n").map(line => JSON.parse(line));
const rows = records.filter(r => JSON.stringify(r.path) === '["result","rows"]')
  .map(r => ({ index: r.index, ...r.value }));
const completed = rows.filter(r => !r.error);
const scales: Record<string, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
};
const summaries = completed.map(r => {
  const pitches = r.notes.map((n: any) => n.midi);
  const degrees = Array.from({ length: 8 }, (_, i) => r.answers[`degree_${i}`].value);
  const intervals = pitches.slice(1).map((p: number, i: number) => p - pitches[i]);
  // Matches the shipped default ABAB playback, not a new model output.
  const playback = Array.from({ length: 32 }, (_, i) =>
    pitches[i % 8] + ((i >= 8 && i < 16) || i >= 24 ? 2 : 0));
  return {
    index: r.index, brief: r.brief, pitches, degrees, intervals,
    scale: r.answers.scale.value, voice: r.voice,
    ascending: intervals.filter((i: number) => i > 0).length,
    repeated: intervals.filter((i: number) => i === 0).length,
    descending: intervals.filter((i: number) => i < 0).length,
    noDescentBeforeLastNote: intervals.slice(0, -1).every((i: number) => i >= 0),
    literalScaleWalk: degrees.join(",") === "tonic,second,third,fourth,fifth,sixth,seventh,tonic",
    originalBeats: r.notes.map((n: any) => n.beats),
    originalPhraseBeats: r.notes.reduce((sum: number, n: any) => sum + n.beats, 0),
    playbackPhraseBeats: 4,
    noteDurationsOverridden: r.notes.filter((n: any) => n.beats !== 0.5).length,
    playbackNotes: playback,
    playbackOutsideDeclaredScale: playback.filter(p => !scales[r.answers.scale.value].includes(p % 12)).length,
    pianoRollPitchMismatch: playback.filter((p, i) => p !== pitches[i % 8]).length,
  };
});
const output = {
  source: "jev-experiments/results/music.jsonl",
  method: "Static reproduction of committed notes and current default ABAB playback. No browser/audio listening or model calls.",
  planned: rows.length, completed: completed.length,
  unavailable: rows.filter(r => r.error).map(r => ({ index: r.index, kind: "HTTP 429 provider overload" })),
  notes: completed.reduce((n, r) => n + r.notes.length, 0),
  totalAdjacentIntervals: summaries.reduce((n, r) => n + r.intervals.length, 0),
  ascendingIntervals: summaries.reduce((n, r) => n + r.ascending, 0),
  repeatedIntervals: summaries.reduce((n, r) => n + r.repeated, 0),
  descendingIntervals: summaries.reduce((n, r) => n + r.descending, 0),
  motifsWithoutDescentBeforeLastNote: summaries.filter(r => r.noDescentBeforeLastNote).length,
  literalScaleWalks: summaries.filter(r => r.literalScaleWalk).length,
  overriddenNoteDurations: summaries.reduce((n, r) => n + r.noteDurationsOverridden, 0),
  ignoredNonTriangleVoices: summaries.filter(r => r.voice !== "triangle").length,
  defaultPlaybackNoteCount: summaries.length * 32,
  defaultPlaybackOutsideDeclaredScale: summaries.reduce((n, r) => n + r.playbackOutsideDeclaredScale, 0),
  defaultPianoRollPitchMismatches: summaries.reduce((n, r) => n + r.pianoRollPitchMismatch, 0),
  humanPreference: records[0].document.result.human_preference,
  rows: summaries,
};
writeFileSync(resolve(import.meta.dir, "music.probe.json"), JSON.stringify(output, null, 2) + "\n");
console.log(JSON.stringify({ ...output, rows: undefined }, null, 2));
