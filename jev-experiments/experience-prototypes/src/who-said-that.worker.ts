/// <reference lib="webworker" />
/**
 * Who said that?, step one in the visitor's browser: the same `listen` the recordings were made
 * with. Everything stays on the device: whisper-tiny.en (≈41 MB) writes the words,
 * all-MiniLM-L6-v2 (≈23 MB) reads the meaning, and Wespeaker's CAM++ (29 MB, Apache-2.0)
 * fingerprints each voice. Cached after the first run.
 */
import { env, pipeline } from "@huggingface/transformers";
import * as ort from "onnxruntime-web";
import { compact, listen, type Models } from "../../live-worlds/who-said-that/signals";
import { SPEAKER_URL, type SpeakerRunner } from "../../live-worlds/who-said-that/speaker";

env.allowLocalModels = false;

type Asr = (audio: Float32Array) => Promise<{ text: string }>;
type Extractor = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist: () => number[][] }>;

let models: Promise<Models> | null = null;

const progress = (label: string) => (p: { status: string; progress?: number; total?: number }) => {
  if (p.status === "progress" && (p.total ?? 0) > 1e6) self.postMessage({ type: "download", label, percent: Math.round(p.progress ?? 0) });
};

async function load(): Promise<Models> {
  // SAFETY: transformers.js types pipelines loosely; these are the ASR and feature-extraction call shapes.
  const asr = (await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", { dtype: "q8", progress_callback: progress("speech-to-text") })) as unknown as Asr;
  const text = (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8", progress_callback: progress("meaning") })) as unknown as Extractor;

  self.postMessage({ type: "download", label: "voice", percent: 0 });

  const bytes = new Uint8Array(await (await fetch(SPEAKER_URL)).arrayBuffer());
  // onnxruntime's graph optimiser changes CAM++'s output (see node-models.ts), so it stays off.
  const session = await ort.InferenceSession.create(bytes, { graphOptimizationLevel: "disabled" });
  const speaker: SpeakerRunner = async (feats, frames) => {
    const out = await session.run({ feats: new ort.Tensor("float32", feats, [1, frames, 80]) });

    return out.embs.data;
  };

  return {
    transcribe: async (a) => (await asr(a)).text,
    embed: async (texts) => (await text(texts, { pooling: "mean", normalize: true })).tolist(),
    speaker,
  };
}

self.onmessage = async (e: MessageEvent<{ channels: Float32Array[] }>) => {
  try {
    models ??= load();

    const m = await models;
    const t0 = performance.now();

    self.postMessage({ type: "ready" });

    const ch = e.data.channels;
    const heard = await listen(ch.length === 1 ? ch[0] : ch, m, (done, total) => self.postMessage({ type: "segment", done, total }));

    self.postMessage({ type: "done", heard: compact(heard), ms: Math.round(performance.now() - t0) });
  } catch (error) {
    models = null;
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
