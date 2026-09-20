import "../../experience-prototypes/scripts/credentials";
import {
  evaluate,
  GatewayError,
} from "../../experience-prototypes/server/gateway";
import {
  initial,
  step,
  question,
  greedy,
  type State,
  type Game,
} from "./engine";
import { writeRecord } from "../../experience-prototypes/scripts/records";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const cache = resolve(import.meta.dir, "../../.cache/arcade-v1");
mkdirSync(cache, { recursive: true });
const episodes: any[] = [];
for (const game of ["snake", "orbital"] as Game[])
  for (const seed of [7, 19, 42])
    for (const policy of ["jev", "greedy"]) {
      const id = `${game}-${seed}-${policy}`,
        file = resolve(cache, id + ".json");
      const e = existsSync(file)
        ? JSON.parse(readFileSync(file, "utf8"))
        : { id, game, seed, policy, state: initial(game, seed), trace: [] };
      episodes.push(e);
      if (policy === "greedy")
        while (e.state.status === "playing") {
          const action = greedy(e.state);
          e.trace.push({
            state: e.state,
            action,
            source: "greedy baseline",
            probabilities: { [action]: 1 },
            latency_ms: 0,
          });
          e.state = step(e.state, action);
        }
    }
let requests = 0,
  interruptions = 0;
while (
  episodes.some((e) => e.policy === "jev" && e.state.status === "playing")
) {
  const pending = episodes.filter(
    (e) => e.policy === "jev" && e.state.status === "playing",
  );
  const qs = Object.fromEntries(pending.map((e) => [e.id, question(e.state)]));
  try {
    const response = await evaluate(
      {
        state: {
          policy:
            "Each question is a separate game. Choose its action independently.",
        },
        questions: qs,
      },
      { apiKey: process.env.AI_GATEWAY_API_KEY!, deadlineMs: 240000 },
    );
    requests++;
    interruptions = 0;
    for (const e of pending) {
      const a = response.answers[e.id];
      e.trace.push({
        state: e.state,
        action: a.value,
        source: "typesafe-ai/jev",
        probabilities: a.probabilities,
        latency_ms: response.service_latency_ms,
        batch_size: pending.length,
        cost_usd: response.cost_usd,
      });
      e.state = step(e.state, a.value);
      writeFileSync(resolve(cache, e.id + ".json"), JSON.stringify(e));
    }
    console.log(
      JSON.stringify({
        requests,
        games: pending.map((e) => ({
          id: e.id,
          tick: e.state.tick,
          score: e.state.score,
          status: e.state.status,
        })),
      }),
    );
  } catch (error) {
    if (
      !(error instanceof GatewayError) ||
      error.status !== 503 ||
      ++interruptions > 8
    )
      throw error;
    console.warn(
      "Transient recording interruption; retaining checkpoints",
      String(error),
    );
    await Bun.sleep(15000);
  }
  await Bun.sleep(2500);
}
const recordedAt = new Date().toISOString();
const record = {
  manifest: { created: recordedAt, experiment: "arcade" },
  experiment: "arcade",
  recorded_at: recordedAt,
  result: {
    method:
      "Seeded original game environments. Same initial seeds for Jev and a greedy code baseline. Code supplies immediate action previews; Jev chooses one action per turn. These are fixed game-clock replays, not a real-time latency claim.",
    sources: [
      {
        name: "TypeSafe Doom demonstration",
        url: "https://typesafe.ai/blog/introducing-system-one-models-and-jev",
      },
    ],
    episodes: episodes.map((e) => ({ ...e, completed: true })),
  },
};
writeRecord(resolve(import.meta.dir, "results.jsonl"), record);
console.log("All arcade episodes completed.");
