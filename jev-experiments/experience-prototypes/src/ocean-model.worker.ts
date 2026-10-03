/// <reference lib="webworker" />
/**
 * Runs the reef's free model (MobileBERT-MNLI, the same model Decide uses) off the main thread,
 * one fish at a time, so the world keeps moving while it thinks.
 */
import { NLI_MODEL, type ZeroShot } from "../../packages/arena/src/decide/nli";
import type { View } from "../../live-worlds/ocean/engine";
import { decideWithNli } from "../../live-worlds/ocean/models";
import { transformers } from "./transformers-lazy";

let clf: Promise<ZeroShot> | null = null;

self.onmessage = async (event: MessageEvent<{ id: number; view: View }>) => {
  const { id, view } = event.data;

  try {
    clf ??= transformers().then(({ pipeline }) =>
      pipeline("zero-shot-classification", NLI_MODEL, {
        dtype: "q8",
        // Only the weights file is worth reporting; the tokenizer and config are tiny.
        progress_callback: (p: { status: string; progress?: number; total?: number }) => {
          if (p.status === "progress" && (p.total ?? 0) > 1e6) self.postMessage({ type: "download", percent: Math.round(p.progress ?? 0) });
        },
      }),
    ) as unknown as Promise<ZeroShot>;

    const decision = await decideWithNli(await clf, view);

    self.postMessage({ type: "decision", id, decision });
  } catch (error) {
    clf = null;
    self.postMessage({ type: "error", id, message: error instanceof Error ? error.message : String(error) });
  }
};
