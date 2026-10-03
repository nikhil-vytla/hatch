/**
 * Synthesises the café clip: 16 kHz mono WAV plus a truth file with each line's speaker and
 * times. Background babble and pink noise are mixed under the scripted lines.
 */
import { KokoroTTS } from "kokoro-js";
import { writeFileSync } from "node:fs";
const S = await import(process.env.SCRIPT ?? "./script");
const { BABBLE, LINES, VOICES } = S as typeof import("./script");

const RATE = 16000;
const out = process.argv[2] ?? ".";

function resample(x: Float32Array, from: number, to: number) {
  const n = Math.floor((x.length * to) / from);
  const y = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const t = (i * from) / to;
    const j = Math.floor(t);
    const f = t - j;

    y[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? 0) * f;
  }

  return y;
}

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });

async function say(text: string, voice: string) {
  const a = await tts.generate(text, { voice: voice as never });

  return resample(a.audio as Float32Array, a.sampling_rate, RATE);
}

const clips: { who: string; text: string; audio: Float32Array; gain: number; gap: number }[] = [];

for (const l of LINES) clips.push({ ...l, audio: await say(l.text, VOICES[l.who]) });

const babble: Float32Array[] = [];

for (const [i, t] of BABBLE.entries()) babble.push(await say(t, i % 2 ? "af_nicole" : "bm_lewis"));

// Lay out the scripted lines.
let t = 0;
const placed: { who: string; text: string; start: number; end: number; gain: number; audio: Float32Array }[] = [];

for (const c of clips) {
  t = Math.max(0, t + c.gap);
  placed.push({ who: c.who, text: c.text, start: t, end: t + c.audio.length / RATE, gain: c.gain, audio: c.audio });
  t += c.audio.length / RATE;
}

const total = Math.ceil((t + 0.8) * RATE);
const mix = new Float32Array(total);

for (const p of placed) {
  const s = Math.floor(p.start * RATE);

  for (let i = 0; i < p.audio.length && s + i < total; i++) mix[s + i] += p.audio[i] * p.gain;
}

// Babble bed: other tables, looped quietly under everything.
let b = 0;
let k = 0;

while (b < total) {
  const a = babble[k++ % babble.length];

  for (let i = 0; i < a.length && b + i < total; i++) mix[b + i] += a[i] * 0.12;

  b += a.length + Math.floor(0.3 * RATE);
}

// Pink-ish noise (Voss-McCartney-lite) for room tone; seeded so the clip is reproducible.
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
let b0 = 0, b1 = 0, b2 = 0;

for (let i = 0; i < total; i++) {
  const w = rnd();

  b0 = 0.99765 * b0 + w * 0.099046;
  b1 = 0.963 * b1 + w * 0.2965164;
  b2 = 0.57 * b2 + w * 1.0526913;
  mix[i] += (b0 + b1 + b2 + w * 0.1848) * 0.006;
}

// Normalise to -1 dBFS and write 16-bit PCM WAV.
let peak = 0;

for (const v of mix) peak = Math.max(peak, Math.abs(v));

const scale = 0.89 / Math.max(peak, 1e-6);
const pcm = Buffer.alloc(44 + total * 2);

pcm.write("RIFF", 0);
pcm.writeUInt32LE(36 + total * 2, 4);
pcm.write("WAVE", 8);
pcm.write("fmt ", 12);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(RATE, 24);
pcm.writeUInt32LE(RATE * 2, 28);
pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34);
pcm.write("data", 36);
pcm.writeUInt32LE(total * 2, 40);

for (let i = 0; i < total; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(mix[i] * scale * 32767))), 44 + i * 2);

writeFileSync(`${out}/cafe.wav`, pcm);
writeFileSync(
  `${out}/cafe.truth.json`,
  JSON.stringify(
    {
      rate: RATE,
      seconds: total / RATE,
      voices: VOICES,
      tags: { me: [placed[0].start, placed[0].end], priya: [placed[1].start, placed[1].end] },
      lines: placed.map(({ who, text, start, end, gain }) => ({ who, text, start: +start.toFixed(3), end: +end.toFixed(3), gain })),
    },
    null,
    1,
  ) + "\n",
);
console.log(`wrote ${(total / RATE).toFixed(1)} s, ${placed.length} lines`);
