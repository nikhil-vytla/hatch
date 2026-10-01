/// <reference lib="webworker" />
/**
 * Runs the square's in-browser model (live-worlds/crowd/browser-model.ts) off the main thread.
 * The model is the same MobileBERT-MNLI Decide uses, downloaded once and cached by the browser.
 */
import { env, pipeline } from "@huggingface/transformers";
import { NLI_MODEL, type ZeroShot } from "../../packages/arena/src/decide/nli";
import { answerCrowd, type CrowdInput } from "../../live-worlds/crowd/browser-model";

env.allowLocalModels = false;

let clf: Promise<ZeroShot> | null = null;

self.onmessage = async (event: MessageEvent<{ id: string; input: CrowdInput }>) => {
  const { id, input } = event.data;

  try {
    clf ??= pipeline("zero-shot-classification", NLI_MODEL, {
      dtype: "q8",
      // Only the weights file is worth reporting; the tokenizer and config files are tiny.
      progress_callback: (p: { status: string; progress?: number; total?: number }) => {
        if (p.status === "progress" && (p.total ?? 0) > 1e6)
          self.postMessage({ type: "download", id, percent: Math.round(p.progress ?? 0) });
      },
    }) as unknown as Promise<ZeroShot>;

    const model = await clf;
    const started = performance.now();
    const { answers, place } = await answerCrowd(model, input, (done, total) =>
      self.postMessage({ type: "resident", id, done, total }),
    );

    self.postMessage({ type: "answer", id, answers, place, ms: Math.round(performance.now() - started) });
  } catch (error) {
    clf = null;
    self.postMessage({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
  }
};
