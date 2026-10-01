/// <reference lib="webworker" />
/**
 * Runs the free in-browser model for Who can you win over?: MobileBERT-MNLI, the same model
 * Decide and The square at five used, downloaded once and cached by the browser. It answers one
 * zero-shot classification per message; the decision logic lives in live-worlds/win-over.
 */
import { env, pipeline } from "@huggingface/transformers";
import { NLI_MODEL, type ZeroShot } from "../../packages/arena/src/decide/nli";

env.allowLocalModels = false;

let clf: Promise<ZeroShot> | null = null;

type Ask = { id: number; premise: string; labels: string[]; options: { hypothesis_template: string; multi_label?: boolean } };

self.onmessage = async (event: MessageEvent<Ask | { id: number; warm: true }>) => {
  const msg = event.data;

  try {
    clf ??= pipeline("zero-shot-classification", NLI_MODEL, {
      dtype: "q8",
      // Only the weights file is worth reporting; the tokenizer and config files are tiny.
      progress_callback: (p: { status: string; progress?: number; total?: number }) => {
        if (p.status === "progress" && (p.total ?? 0) > 1e6) self.postMessage({ type: "download", percent: Math.round(p.progress ?? 0) });
      },
    }) as unknown as Promise<ZeroShot>;

    const model = await clf;

    if ("warm" in msg) {
      self.postMessage({ type: "ready", id: msg.id });

      return;
    }

    const r = await model(msg.premise, msg.labels, msg.options);

    self.postMessage({ type: "answer", id: msg.id, labels: r.labels, scores: r.scores });
  } catch (error) {
    clf = null;
    self.postMessage({ type: "error", id: msg.id, message: error instanceof Error ? error.message : String(error) });
  }
};
