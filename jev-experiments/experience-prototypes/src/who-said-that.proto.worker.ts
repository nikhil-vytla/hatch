/// <reference lib="webworker" />
/**
 * PROTOTYPE — Who said that?, run in the visitor's browser. Everything stays on the device:
 * whisper-tiny.en (≈41 MB) writes the words, all-MiniLM-L6-v2 (≈23 MB) reads the topic, and
 * Wespeaker's CAM++ (29 MB, Apache-2.0) fingerprints each voice. Cached after the first run.
 */
import { env, pipeline } from "@huggingface/transformers";
import * as ort from "onnxruntime-web";
import { hear, type Line } from "../../live-worlds/who-said-that/pipeline.proto";
import { SPEAKER_URL, type SpeakerRunner } from "../../live-worlds/who-said-that/speaker.proto";

env.allowLocalModels = false;

type Asr = (audio: Float32Array) => Promise<{ text: string }>;
type Extractor = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist: () => number[][] }>;

let models: Promise<{ asr: Asr; text: Extractor; speaker: SpeakerRunner }> | null = null;

const progress = (label: string) => (p: { status: string; progress?: number; total?: number }) => {
  if (p.status === "progress" && (p.total ?? 0) > 1e6) self.postMessage({ type: "download", label, percent: Math.round(p.progress ?? 0) });
};

async function load() {
  // SAFETY: transformers.js types pipelines loosely; these are the ASR and feature-extraction call shapes.
  const asr = (await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", { dtype: "q8", progress_callback: progress("speech-to-text") })) as unknown as Asr;
  const text = (await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8", progress_callback: progress("topic") })) as unknown as Extractor;

  self.postMessage({ type: "download", label: "voice", percent: 0 });

  const bytes = new Uint8Array(await (await fetch(SPEAKER_URL)).arrayBuffer());
  // onnxruntime's graph optimiser changes CAM++'s output (see node-models.proto.ts), so it stays off.
  const session = await ort.InferenceSession.create(bytes, { graphOptimizationLevel: "disabled" });
  const speaker: SpeakerRunner = async (feats, frames) => {
    const out = await session.run({ feats: new ort.Tensor("float32", feats, [1, frames, 80]) });

    return out.embs.data as Float32Array;
  };

  return { asr, text, speaker };
}

self.onmessage = async (e: MessageEvent<{ audio: Float32Array; tagged: { me: [number, number]; friend: [number, number] } }>) => {
  try {
    models ??= load();

    const m = await models;

    self.postMessage({ type: "ready" });

    const r = await hear(
      e.data.audio,
      e.data.tagged,
      {
        transcribe: async (a) => (await m.asr(a)).text,
        embed: async (texts) => (await m.text(texts, { pooling: "mean", normalize: true })).tolist(),
        speaker: m.speaker,
      },
      (done, total) => self.postMessage({ type: "segment", done, total }),
    );
    const lines: Omit<Line, "voice" | "meaning">[] = r.lines.map(({ voice: _v, meaning: _m, ...l }) => l);

    self.postMessage({ type: "done", lines, ms: r.ms });
  } catch (error) {
    models = null;
    self.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
};
