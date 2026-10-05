/**
 * Held-out evaluation of the reef's deciders on test seeds never used in training or checkpoint
 * selection, and on oil spills, an event the policy never trained on. Writes heldout.json.
 *
 * Same protocol as the page's race: the event at 15 s, 60 s in all, 120 fish.
 * - Nobody decides: every fish keeps its first action.
 * - Hand-written rule, evolved policy: every live fish decides 10 times a second.
 * - Evolved policy at 5 a second, and MobileBERT at 5 a second: the rate MobileBERT measured in
 *   the browser (about 185 ms per fish), so both get the same decision budget.
 *
 * Jev isn't run here (no new calls). The page compares against its one recorded race run, as
 * evaluation only.
 *
 *   bun live-worlds/ocean/heldout.ts [--seeds 20] [--mobilebert-events heatwave,net]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import type { ZeroShot } from "../../packages/arena/src/decide/nli";
import { nliInProcess } from "./deciders";
import type { EventKind } from "./engine";
import { runEpisode, type Episode, type Result } from "./evaluate";

export const TEST_SEED_FROM = 5000;
export const EVENTS: EventKind[] = ["heatwave", "net", "storm", "bloom", "oil"];
export const MOBILEBERT_RATE = 5;

export const testEpisode = (seed: number, event: EventKind, budget: number): Episode => ({ seed, event, eventAt: 15, seconds: 60, budget, every: 3 });

type Job = { kind: string; budget: number; episode: Episode };

export function summarize(results: Result[]) {
  const survival = results.map((r) => (r.cohort ? r.survived / r.cohort : 0));
  const alive = results.map((r) => r.alive);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const sd = (xs: number[]) => {
    const m = mean(xs);

    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
  };

  return { n: results.length, survival: mean(survival), survivalSd: sd(survival), alive: mean(alive), aliveSd: sd(alive) };
}

if (import.meta.main) {
  const arg = (name: string, d: string) => {
    const i = process.argv.indexOf(`--${name}`);

    return i > 0 ? process.argv[i + 1] : d;
  };
  const seeds = Array.from({ length: Number(arg("seeds", "20")) }, (_, i) => TEST_SEED_FROM + i);
  const bertEvents = arg("mobilebert-events", "heatwave,net").split(",").filter(Boolean) as EventKind[];
  const policy = JSON.parse(readFileSync(new URL("./policy.json", import.meta.url), "utf8"));
  const deciders = [
    { kind: "nobody", label: "Nobody decides", budget: 0, events: EVENTS },
    { kind: "rule", label: "Hand-written rule", budget: Infinity, events: EVENTS },
    { kind: "evolved", label: "Evolved policy", budget: Infinity, events: EVENTS },
    { kind: "evolved", label: `Evolved policy at ${MOBILEBERT_RATE}/s`, budget: MOBILEBERT_RATE, events: EVENTS },
    { kind: "mobilebert", label: `MobileBERT at ${MOBILEBERT_RATE}/s`, budget: MOBILEBERT_RATE, events: bertEvents },
  ];
  const jobs: (Job & { label: string })[] = deciders.flatMap((d) =>
    d.events.flatMap((ev) => seeds.map((s) => ({ kind: d.kind, label: d.label, budget: d.budget, episode: testEpisode(s, ev, d.budget) }))),
  );
  const results: Result[] = Array(jobs.length);
  let done = 0;

  /** Runs some of the jobs on a pool of `size` workers. */
  const runPool = (ids: number[], size: number) =>
    new Promise<void>((resolve) => {
      if (!ids.length) return resolve();

      const workers = Array.from({ length: Math.min(size, ids.length) }, () => new Worker(new URL("./heldout-worker.ts", import.meta.url).href));
      let next = 0;
      let finished = 0;

      const feed = (wk: Worker) => {
        if (next >= ids.length) return;

        const job = ids[next++];

        wk.postMessage({ job, kind: jobs[job].kind, weights: policy.weights, episode: jobs[job].episode });
      };

      for (const wk of workers) {
        wk.onmessage = (e: MessageEvent<{ job: number; result: Result }>) => {
          results[e.data.job] = e.data.result;
          done++;
          finished++;

          if (done % 50 === 0) console.log(`${done} of ${jobs.length}`);

          if (finished === ids.length) {
            workers.forEach((w) => w.terminate());
            resolve();
          } else feed(wk);
        };
        feed(wk);
      }
    });

  const all = jobs.map((_, i) => i);

  await runPool(all.filter((i) => jobs[i].kind !== "mobilebert"), Math.max(1, availableParallelism() - 2));

  // MobileBERT runs on the main thread: onnxruntime crashes the process silently inside a Bun worker.
  const bert = all.filter((i) => jobs[i].kind === "mobilebert");

  if (bert.length) {
    const { pipeline } = await import("@huggingface/transformers");
    const { NLI_MODEL } = await import("../../packages/arena/src/decide/nli");
    // SAFETY: transformers.js's zero-shot pipeline is called with (premise, labels, options), the ZeroShot shape.
    const clf = (await pipeline("zero-shot-classification", NLI_MODEL, { dtype: "q8" })) as unknown as ZeroShot;
    const mobilebert = nliInProcess(clf);

    for (const i of bert) {
      results[i] = await runEpisode(jobs[i].episode, mobilebert);
      done++;

      if (done % 10 === 0) console.log(`${done} of ${jobs.length}`);
    }
  }

  const table = deciders.map((d) => ({
    decider: d.label,
    byEvent: Object.fromEntries(
      d.events.map((ev) => [ev, summarize(results.filter((_, i) => jobs[i].label === d.label && jobs[i].episode.event === ev))]),
    ),
  }));

  writeFileSync(
    new URL("./heldout.json", import.meta.url),
    JSON.stringify({ protocol: "Test seeds 5000–5019, never used in training or selection. Event at 15 s, 60 s, 120 fish. Oil was never seen in training.", seeds: seeds.length, table }, null, 1) + "\n",
  );

  for (const row of table)
    console.log(
      row.decider.padEnd(26),
      Object.entries(row.byEvent)
        .map(([ev, s]) => `${ev} ${(s.survival * 100).toFixed(0)}%±${(s.survivalSd * 100).toFixed(0)} alive ${s.alive.toFixed(0)}`)
        .join(" | "),
    );
}
