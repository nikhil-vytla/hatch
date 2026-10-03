/**
 * PROTOTYPE — Who said that? from the command line (and behind the Mac menu-bar app). Everything
 * runs on this machine: whisper-tiny.en, all-MiniLM-L6-v2 and CAM++, no network after the first
 * model download.
 *
 *   bun live-worlds/who-said-that/cli.proto.ts --me me.wav --friend friend.wav --talk talk.wav \
 *     [--names "Me,Priya"] [--out transcript.md] [--background]
 *
 * WAVs must be 16 kHz mono 16-bit (the Mac app records exactly that; otherwise
 * `ffmpeg -i in -ar 16000 -ac 1 out.wav`).
 */
import { writeFileSync } from "node:fs";
import { hear, markdown } from "./pipeline.proto";
import { nodeModels, readWav } from "./node-models.proto";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);

  return i >= 0 ? args[i + 1] : undefined;
};

const mePath = opt("me");
const friendPath = opt("friend");
const talkPath = opt("talk");

if (!mePath || !friendPath || !talkPath) {
  console.error("Usage: cli.proto.ts --me me.wav --friend friend.wav --talk talk.wav [--names Me,Priya] [--out file.md] [--background]");
  process.exit(2);
}

const [meName, friendName] = (opt("names") ?? "Me,Friend").split(",");
const me = readWav(mePath);
const friend = readWav(friendPath);
const talk = readWav(talkPath);
// The tags go first, so the pipeline can fingerprint them; their own lines are dropped below.
const all = new Float32Array(me.length + friend.length + talk.length);

all.set(me);
all.set(friend, me.length);
all.set(talk, me.length + friend.length);

const offset = (me.length + friend.length) / 16000;
const t0 = performance.now();
const models = await nodeModels({ speaker: true });
const r = await hear(all, { me: [0, me.length / 16000], friend: [me.length / 16000, offset] }, models, (d, n) => process.stderr.write(`\rTranscribing ${d}/${n}`));

process.stderr.write("\n");

const lines = r.lines.filter((l) => l.start >= offset - 0.05).map((l) => ({ ...l, start: l.start - offset, end: l.end - offset }));
const md = `# Transcript\n\n_Made on this Mac by Who said that? (prototype) in ${((performance.now() - t0) / 1000).toFixed(1)} s. Speakers are decided by voice, topic and sentence continuation; check before you rely on it._\n\n${markdown(lines, { me: meName, friend: friendName ?? "Friend" }, args.includes("--background"))}`;
const out = opt("out");

if (out) {
  writeFileSync(out, md);
  console.log(out);
} else process.stdout.write(md);
