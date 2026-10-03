/**
 * Who said that? from the command line, and behind the Mac menu-bar app. Give it one recording
 * of a room; it writes a Markdown transcript sorted into conversations and speakers. Everything
 * runs on this machine (whisper-tiny.en, all-MiniLM-L6-v2, CAM++) with the free decisions; no
 * network after the first model download.
 *
 *   bun live-worlds/who-said-that/cli.ts room.wav [--out transcript.md]
 *
 * WAVs must be 16 kHz 16-bit (the Mac app records exactly that; otherwise
 * `ffmpeg -i in -ar 16000 -ac 1 out.wav`). A two-channel WAV is read as one microphone per table.
 */
import { writeFileSync } from "node:fs";
import { ALL_ON, counts, decide, hindsight } from "./decide";
import { nodeModels, readWavChannels } from "./node-models";
import { freeAnswers } from "./questions";
import { listen } from "./signals";
import { markdown } from "./transcript";

const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out");
const outAt = args.indexOf("--out");

if (!path) {
  console.error("Usage: cli.ts room.wav [--out transcript.md]");
  process.exit(2);
}

const t0 = performance.now();
const channels = readWavChannels(path);
const heard = await listen(channels.length === 1 ? channels[0] : channels, await nodeModels(), (d, n) => process.stderr.write(`\rTranscribing ${d}/${n}`));

process.stderr.write("\n");

const state = decide(heard, freeAnswers(heard));
const late = hindsight(state, heard, ALL_ON);
const c = counts(state);
const md =
  `# Transcript\n\n_Made on this machine by Who said that? (prototype tool) in ${((performance.now() - t0) / 1000).toFixed(1)} s: ` +
  `${c.speakers} speaker${c.speakers === 1 ? "" : "s"}, ${c.conversations} conversation${c.conversations === 1 ? "" : "s"}, ${c.topics} topic${c.topics === 1 ? "" : "s"}. ` +
  `Speakers are told apart by voice and loudness, conversations by topic and replies. Check it before you rely on it._\n\n${markdown(heard, late)}\n`;

if (outAt >= 0) {
  writeFileSync(args[outAt + 1], md);
  console.log(args[outAt + 1]);
} else process.stdout.write(md);
