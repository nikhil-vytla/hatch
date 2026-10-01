/// <reference lib="webworker" />
/** Runs one held-out episode for one fast decider; heldout.ts runs a pool of these (MobileBERT runs on its main thread). */
import { runEpisode, type Episode } from "./evaluate";
import { decideAll } from "./policy";
import { ruleDecisions } from "./rule";

self.onmessage = async (e: MessageEvent<{ job: number; kind: string; weights: number[]; episode: Episode }>) => {
  const { job, kind, weights, episode } = e.data;
  const result =
    kind === "nobody"
      ? await runEpisode(episode, null)
      : kind === "rule"
        ? await runEpisode(episode, (w, fish) => ruleDecisions(w, fish))
        : await runEpisode(episode, (w, fish) => decideAll(w, { weights }, fish));

  self.postMessage({ job, result });
};
