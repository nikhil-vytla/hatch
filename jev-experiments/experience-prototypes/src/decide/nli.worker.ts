/// <reference lib="webworker" />
/**
 * Runs Decide's zero-shot contestant in the visitor's browser: the same model and code the
 * recording used (packages/arena/src/decide/nli.ts), downloaded once and cached by the browser.
 */
import { env, pipeline } from "@huggingface/transformers";
import { answerWithNli, NLI_MODEL, type ZeroShot } from "../../../packages/arena/src/decide/nli";
import type { WireQuestion } from "../../../packages/arena/src/checkable/items";

env.allowLocalModels = false;

let clf: Promise<ZeroShot> | null = null;

type Job = {
  id: string;
  request: { state: Record<string, string>; questions: Record<string, WireQuestion> };
};

self.onmessage = async (event: MessageEvent<{ jobs: Job[] }>) => {
  try {
    clf ??= pipeline("zero-shot-classification", NLI_MODEL, {
      dtype: "q8",
      progress_callback: (p: { status: string; progress?: number }) => {
        if (p.status === "progress")
          self.postMessage({ type: "progress", percent: Math.round(p.progress ?? 0) });
      },
    }) as unknown as Promise<ZeroShot>;
    const model = await clf;

    for (const job of event.data.jobs) {
      const started = performance.now();
      const answers = await answerWithNli(model, job.request);

      self.postMessage({
        type: "answer",
        id: job.id,
        answers,
        ms: Math.round(performance.now() - started),
      });
    }

    self.postMessage({ type: "done" });
  } catch (error) {
    clf = null;
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
