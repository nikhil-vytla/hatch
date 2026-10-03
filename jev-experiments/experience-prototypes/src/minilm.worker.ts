/// <reference lib="webworker" />
/**
 * Embeds text with all-MiniLM-L6-v2 in the browser: a rumour for the rumour mill, a line for
 * Who can you win over?. Same model and settings as live-worlds/rumour/vectors.json and the free
 * model's training data (live-worlds/free-model), so the small networks see what they trained on.
 */
import { EMBED_MODEL } from "../../live-worlds/rumour/similarity";
import { transformers } from "./transformers-lazy";

type Extractor = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist: () => number[][] }>;

let extractor: Promise<Extractor> | null = null;

self.onmessage = async (event: MessageEvent<{ id: string; text: string }>) => {
  const { id, text } = event.data;

  try {
    // SAFETY: transformers.js types the pipeline loosely; this is the feature-extraction call shape.
    extractor ??= transformers().then(({ pipeline }) =>
      pipeline("feature-extraction", EMBED_MODEL, {
        dtype: "q8",
        // Only the weights file is worth reporting; the tokenizer and config files are tiny.
        progress_callback: (p: { status: string; progress?: number; total?: number }) => {
          if (p.status === "progress" && (p.total ?? 0) > 1e6) self.postMessage({ type: "download", id, percent: Math.round(p.progress ?? 0) });
        },
      }),
    ) as unknown as Promise<Extractor>;

    const embed = await extractor;
    const started = performance.now();
    const [vector] = (await embed([text], { pooling: "mean", normalize: true })).tolist();

    self.postMessage({ type: "vector", id, vector, ms: Math.round(performance.now() - started) });
  } catch (error) {
    extractor = null;
    self.postMessage({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
  }
};
