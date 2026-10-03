/** Node models and WAV reading for the recorder and the CLI. */
import { pipeline } from "@huggingface/transformers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import type { Models } from "./signals";
import { SPEAKER_URL, type SpeakerRunner } from "./speaker";

export const ASR_MODEL = "Xenova/whisper-tiny.en";
export const TEXT_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Every channel of a 16-bit PCM WAV at 16 kHz (what the recorder, build.py and the Mac app write). */
export function readWavChannels(path: string): Float32Array[] {
  const b = readFileSync(path);
  let o = 12;
  let rate = 0;
  let channels = 1;

  while (o < b.length) {
    const id = b.toString("ascii", o, o + 4);
    const size = b.readUInt32LE(o + 4);

    if (id === "fmt ") {
      channels = b.readUInt16LE(o + 10);
      rate = b.readUInt32LE(o + 12);
    }

    if (id === "data") {
      if (rate !== 16000) throw new Error(`Expected 16 kHz audio, got ${rate} Hz. Convert with: ffmpeg -i in -ar 16000 out.wav`);

      const n = Math.floor(size / 2 / channels);
      const out = Array.from({ length: channels }, () => new Float32Array(n));

      for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++) out[c][i] = b.readInt16LE(o + 8 + (i * channels + c) * 2) / 32768;

      return out;
    }

    o += 8 + size + (size % 2);
  }

  throw new Error("No audio data in WAV file.");
}

/** A WAV as one channel (the mean of its channels). */
export function readWav(path: string): Float32Array {
  const ch = readWavChannels(path);

  if (ch.length === 1) return ch[0];

  const out = new Float32Array(ch[0].length);

  for (let i = 0; i < out.length; i++) out[i] = ch.reduce((s, c) => s + c[i], 0) / ch.length;

  return out;
}

/** CAM++ on onnxruntime-node, downloaded once to ~/.cache/who-said-that/. */
export async function nodeSpeaker(): Promise<SpeakerRunner> {
  const dir = join(homedir(), ".cache", "who-said-that");
  const path = join(dir, "campplus.onnx");

  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const r = await fetch(SPEAKER_URL);

    if (!r.ok) throw new Error(`Could not download the voice model (${r.status}).`);

    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  }

  // onnxruntime 1.21's graph optimiser silently changes CAM++'s output (checked against Python's
  // onnxruntime and kaldi-native-fbank: 24/24 speakers right with it off, 11/24 with it on).
  const session = await ort.InferenceSession.create(path, { graphOptimizationLevel: "disabled" });

  return async (feats, frames) => {
    const out = await session.run({ feats: new ort.Tensor("float32", feats, [1, frames, 80]) });

    return out.embs.data as Float32Array;
  };
}

export async function nodeModels(): Promise<Models> {
  const asr = await pipeline("automatic-speech-recognition", ASR_MODEL, { dtype: "q8" });
  const text = await pipeline("feature-extraction", TEXT_MODEL, { dtype: "q8" });

  const speaker = await nodeSpeaker();

  return {
    speaker,
    transcribe: async (audio) => {
      const r = (await asr(audio)) as { text: string };

      return r.text;
    },
    embed: async (texts) => {
      const t = await text(texts, { pooling: "mean", normalize: true });

      return t.tolist() as number[][];
    },
  };
}
