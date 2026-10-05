/// <reference lib="webworker" />
/** Scores one candidate policy on a list of episodes; train.ts runs a pool of these. */
import { evolved } from "./deciders";
import { fitness, runEpisode, type Episode } from "./evaluate";

self.onmessage = async (e: MessageEvent<{ job: number; weights: number[]; episodes: Episode[] }>) => {
  const { job, weights, episodes } = e.data;
  const decider = evolved({ weights });
  let total = 0;

  for (const ep of episodes) total += fitness(await runEpisode(ep, decider));

  self.postMessage({ job, score: total / episodes.length });
};
