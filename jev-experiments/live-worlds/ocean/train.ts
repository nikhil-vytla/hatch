/**
 * Evolves the reef's free policy (policy.ts) with an evolution strategy: antithetic Gaussian
 * perturbations, centred-rank fitness, Adam. Fitness is survival in this reef only; no model's
 * answers are used anywhere. Episodes come from training seeds and four events; oil spills are
 * held out entirely, validation seeds pick the checkpoint, and test seeds are never touched here.
 *
 *   bun live-worlds/ocean/train.ts [--generations 80] [--out live-worlds/ocean/policy.json]
 */
import { writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import type { EventKind } from "./engine";
import type { Episode } from "./evaluate";
import { WEIGHT_COUNT } from "./policy";
import { mulberry32 } from "../../packages/seeded/src/index";

export const TRAIN_EVENTS: EventKind[] = ["heatwave", "net", "storm", "bloom"];
export const TRAIN_SEEDS = { from: 100, to: 999 };
export const VALIDATION_SEEDS = Array.from({ length: 12 }, (_, i) => 1000 + i);
/** Decide every live fish every 3 ticks (10 times a second each) in training, as on the page. */
export const EVERY = 3;

/** A seeded generator (mulberry32) and standard normals from it. */
export function rng(seed: number) {
  const next = mulberry32(seed);

  const normal = () => {
    const u = Math.max(1e-12, next());

    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };

  return { next, normal };
}

/** A short training episode: the event early, then long enough for its outcome to be reported. */
export const trainingEpisode = (seed: number, event: EventKind): Episode => ({ seed, event, eventAt: 5, seconds: 45, budget: Infinity, every: EVERY });

export type Step = { theta: number[]; m: number[]; v: number[]; t: number };

export const initial = (seed: number): Step => {
  const r = rng(seed);

  return { theta: Array.from({ length: WEIGHT_COUNT }, () => r.normal() * 0.3), m: Array(WEIGHT_COUNT).fill(0), v: Array(WEIGHT_COUNT).fill(0), t: 0 };
};

/** Centred ranks in [-0.5, 0.5], so one lucky episode can't dominate. */
export function centredRanks(scores: number[]) {
  const order = scores.map((s, i) => [s, i] as const).sort((a, b) => a[0] - b[0]);
  const out = Array(scores.length).fill(0);

  order.forEach(([, i], rank) => {
    out[i] = scores.length > 1 ? rank / (scores.length - 1) - 0.5 : 0;
  });

  return out;
}

/**
 * One generation. `score` evaluates candidate weights on the generation's episodes (the same
 * episodes for every candidate). Deterministic given the step, the generation seed and `score`.
 */
export async function generation(
  s: Step,
  genSeed: number,
  score: (weights: number[], episodes: Episode[]) => Promise<number[]>,
  opts = { pairs: 12, sigma: 0.08, lr: 0.04, decay: 0.002, episodes: 6 },
) {
  const r = rng(genSeed);
  const eps = Array.from({ length: opts.pairs }, () => Array.from({ length: WEIGHT_COUNT }, () => r.normal()));
  const episodes = Array.from({ length: opts.episodes }, () =>
    trainingEpisode(TRAIN_SEEDS.from + Math.floor(r.next() * (TRAIN_SEEDS.to - TRAIN_SEEDS.from)), TRAIN_EVENTS[Math.floor(r.next() * TRAIN_EVENTS.length)]),
  );
  const candidates = eps.flatMap((e) => [s.theta.map((x, i) => x + opts.sigma * e[i]), s.theta.map((x, i) => x - opts.sigma * e[i])]);
  const scores = await score(candidates.flat(), episodes);
  const ranks = centredRanks(scores);
  const grad = Array(WEIGHT_COUNT).fill(0);

  eps.forEach((e, k) => {
    const d = ranks[2 * k] - ranks[2 * k + 1];

    for (let i = 0; i < WEIGHT_COUNT; i++) grad[i] += (d * e[i]) / (2 * opts.pairs * opts.sigma);
  });

  // Adam ascent with a little weight decay.
  const t = s.t + 1;
  const m = s.m.map((x, i) => 0.9 * x + 0.1 * grad[i]);
  const v = s.v.map((x, i) => 0.999 * x + 0.001 * grad[i] * grad[i]);
  const theta = s.theta.map((x, i) => x + (opts.lr * (m[i] / (1 - 0.9 ** t))) / (Math.sqrt(v[i] / (1 - 0.999 ** t)) + 1e-8) - opts.decay * x);

  return { step: { theta, m, v, t }, mean: scores.reduce((a, b) => a + b, 0) / scores.length, best: Math.max(...scores) };
}

/** A pool of workers that score many candidates in parallel. */
export function pool(size = Math.max(1, availableParallelism() - 2)) {
  const workers = Array.from({ length: size }, () => new Worker(new URL("./train-worker.ts", import.meta.url).href));

  /** Scores each candidate on `episodes`, or candidate i on `episodes[i]` when given one list each. */
  const score = (flat: number[], episodes: Episode[] | Episode[][]) => {
    const n = flat.length / WEIGHT_COUNT;
    const out: number[] = Array(n).fill(0);
    let next = 0;
    let done = 0;

    return new Promise<number[]>((resolve) => {
      const feed = (wk: Worker) => {
        if (next >= n) return;

        const job = next++;

        const mine = Array.isArray(episodes[0]) ? (episodes as Episode[][])[job] : (episodes as Episode[]);

        wk.postMessage({ job, weights: flat.slice(job * WEIGHT_COUNT, (job + 1) * WEIGHT_COUNT), episodes: mine });
      };

      for (const wk of workers) {
        wk.onmessage = (e: MessageEvent<{ job: number; score: number }>) => {
          out[e.data.job] = e.data.score;
          done++;

          if (done === n) resolve(out);
          else feed(wk);
        };
        feed(wk);
      }
    });
  };

  return { score, close: () => workers.forEach((w) => w.terminate()) };
}

if (import.meta.main) {
  const arg = (name: string, d: string) => {
    const i = process.argv.indexOf(`--${name}`);

    return i > 0 ? process.argv[i + 1] : d;
  };
  const generations = Number(arg("generations", "80"));
  const out = arg("out", new URL("./policy.json", import.meta.url).pathname);
  const p = pool();
  const validation = VALIDATION_SEEDS.flatMap((seed) => TRAIN_EVENTS.map((ev) => trainingEpisode(seed, ev)));
  const validate = async (theta: number[]) => {
    const scores = await p.score(validation.flatMap(() => theta), validation.map((e) => [e]));

    return scores.reduce((a, b) => a + b, 0) / scores.length;
  };
  let s = initial(1);
  let best = { score: await validate(s.theta), theta: s.theta, gen: 0 };
  const log: { gen: number; mean: number; best: number; validation?: number }[] = [];

  console.log(`gen 0 validation ${best.score.toFixed(3)}`);

  for (let g = 1; g <= generations; g++) {
    const r = await generation(s, 7000 + g, p.score);

    s = r.step;

    const row: (typeof log)[number] = { gen: g, mean: r.mean, best: r.best };

    if (g % 5 === 0) {
      row.validation = await validate(s.theta);

      if (row.validation > best.score) best = { score: row.validation, theta: s.theta, gen: g };
    }

    log.push(row);
    console.log(`gen ${g} mean ${r.mean.toFixed(3)} best ${r.best.toFixed(3)}${row.validation !== undefined ? ` validation ${row.validation.toFixed(3)}` : ""}`);
  }

  p.close();
  writeFileSync(
    out,
    JSON.stringify({
      name: "Evolved policy",
      trainedOn: "Survival in this reef only: training seeds 100–999, events heatwave, net, storm, bloom. No model answers.",
      generations,
      chosenAt: best.gen,
      validation: Number(best.score.toFixed(4)),
      weights: best.theta.map((x) => Number(x.toFixed(4))),
      log,
    }) + "\n",
  );
  console.log(`saved generation ${best.gen} (validation ${best.score.toFixed(3)}) to ${out}`);
}
