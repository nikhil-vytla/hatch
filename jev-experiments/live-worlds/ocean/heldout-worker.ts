/// <reference lib="webworker" />
/** Runs one held-out episode for one fast decider; heldout.ts runs a pool of these (MobileBERT runs on its main thread). */
import { evolved, rule } from "./deciders";
import { runEpisode, type Episode } from "./evaluate";

self.onmessage = async (e: MessageEvent<{ job: number; kind: string; weights: number[]; episode: Episode }>) => {
  const { job, kind, weights, episode } = e.data;
  const result = await runEpisode(episode, kind === "nobody" ? null : kind === "rule" ? rule : evolved({ weights }));

  self.postMessage({ job, result });
};
