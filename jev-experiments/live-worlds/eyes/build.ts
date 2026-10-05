/**
 * Builds public/eyes/eyes.json for the Eyes against state page: the lane summaries (summary.ts),
 * the recorded vision-model frames for replay, the prompts, and the perception check. Runs in
 * prepare.ts after public/data/arcade.json exists. A missing recording is left out, never invented.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readRows } from "../../packages/jev-client/src/recordings";
import { PROMPTS, type FrameRecord } from "./model";
import { greedyLane, jevLane, perceptionSummary, SEEDS, vlmLane, type JevEpisode, type PerceptionRow } from "./summary";

/** The recorded runs, in the order the page offers them. The first is the default. */
export const RUNS = [
  { id: "qwen3-vl-4b.v1", label: "Qwen3-VL-4B", prompt: "v1" },
  { id: "qwen3-vl-4b.v2", label: "Qwen3-VL-4B, clearer wording", prompt: "v2" },
  { id: "qwen3-vl-8b.v1", label: "Qwen3-VL-8B", prompt: "v1" },
] as const;


export function eyesData(lab: string, app: string) {
  const dir = join(lab, "live-worlds/eyes/recordings");
  const arcadePath = join(app, "public/data/arcade.json");
  const arcade = existsSync(arcadePath) ? JSON.parse(readFileSync(arcadePath, "utf8")) : null;
  const jev: JevEpisode[] = (arcade?.result?.episodes ?? []).filter((e: { game: string; policy: string }) => e.game === "snake" && e.policy === "jev");

  const runs = RUNS.flatMap((r) => {
    const rows = readRows<FrameRecord>(join(dir, `${r.id}.jsonl`));

    if (!rows.length) return [];

    return [
      {
        ...r,
        model: rows[0].model,
        server: rows[0].server,
        recordedAt: rows[0].at.slice(0, 10),
        summary: vlmLane(r.id, r.label, rows),
        // What the replay needs, per move.
        frames: rows.map((x) => ({ seed: x.seed, tick: x.tick, p: x.probabilities, chosen: x.chosen, move: x.move, greedy: x.greedy, ms: x.ms, sha: x.frame_sha256.slice(0, 12) })),
      },
    ];
  });

  const perception = readRows<PerceptionRow & { model: string }>(join(dir, "qwen3-vl-8b.perception.jsonl"));

  return {
    seeds: SEEDS,
    prompts: PROMPTS,
    greedy: greedyLane(),
    jev: jev.length ? jevLane(jev) : null,
    // Jev's recorded moves on its three seeds, for the facts lane's replay.
    jevTraces: Object.fromEntries(jev.map((e) => [e.seed, e.trace.map((t) => ({ action: (t as { action?: string }).action ?? "straight", ms: t.latency_ms ?? null }))])),
    runs,
    perception: perception.length ? { model: perception[0].model, ...perceptionSummary(perception) } : null,
  };
}

export type EyesData = ReturnType<typeof eyesData>;

export function buildEyes(lab: string, app: string, outDir: string) {
  const data = eyesData(lab, app);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "eyes.json"), JSON.stringify(data) + "\n");

  return data.runs.length;
}
