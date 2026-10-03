/** PROTOTYPE — Node models and WAV reading for the recorder and the CLI. */
import { pipeline } from "@huggingface/transformers";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import type { Models } from "./pipeline.proto";
import { SPEAKER_URL, type SpeakerRunner } from "./speaker.proto";

export const ASR_MODEL = "Xenova/whisper-tiny.en";
export const TEXT_MODEL = "Xenova/all-MiniLM-L6-v2";

/** 16-bit PCM mono WAV at 16 kHz (what the recorder and the Mac app write). */
export function readWav(path: string): Float32Array {
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
      if (rate !== 16000) throw new Error(`Expected 16 kHz audio, got ${rate} Hz. Convert with: ffmpeg -i in -ar 16000 -ac 1 out.wav`);

      const n = Math.floor(size / 2 / channels);
      const x = new Float32Array(n);

      for (let i = 0; i < n; i++) x[i] = b.readInt16LE(o + 8 + i * 2 * channels) / 32768;

      return x;
    }

    o += 8 + size + (size % 2);
  }

  throw new Error("No audio data in WAV file.");
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

export async function nodeModels(opts: { speaker?: boolean } = {}): Promise<Models> {
  const asr = await pipeline("automatic-speech-recognition", ASR_MODEL, { dtype: "q8" });
  const text = await pipeline("feature-extraction", TEXT_MODEL, { dtype: "q8" });

  const speaker = opts.speaker ? await nodeSpeaker() : undefined;

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
