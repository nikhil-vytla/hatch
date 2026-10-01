/// <reference lib="webworker" />
/** Scores one candidate policy on a list of episodes; train.ts runs a pool of these. */
import { fitness, runEpisode, type Episode } from "./evaluate";
import { decideAll } from "./policy";

self.onmessage = async (e: MessageEvent<{ job: number; weights: number[]; episodes: Episode[] }>) => {
  const { job, weights, episodes } = e.data;
  let total = 0;

  for (const ep of episodes) total += fitness(await runEpisode(ep, (w, f) => decideAll(w, { weights }, f)));

  self.postMessage({ job, score: total / episodes.length });
};
