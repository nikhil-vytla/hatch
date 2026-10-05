/**
 * Does breaking a hard question into small ones help Jev? For the first 30 Tetris and first 30
 * grid items in bank order (not chosen by result), ask one call per item with the hard question
 * split into small local ones, let code combine them, and compare with the single-question
 * answers already recorded (recordings/checkable.jsonl.gz). The state Jev sees is unchanged.
 *
 *   Tetris "lowest stack": three pairwise questions ("the piece in A is drawn lower than in B"),
 *     the landing that wins the most comparisons (by summed probability) is the pick.
 *   Tetris "fewest holes": per landing, "leaves an empty cell directly under the piece" (a local
 *     pattern); the landing least likely to is the pick.
 *   Grid "can exit": reach E without D (p1), reach K without D (p2), from K reach E (p3);
 *     P(exit) = p1 + (1 - p1) · p2 · p3.
 *
 *   bun jev-experiments/packages/arena/scripts/decompose-experiment.ts
 */
import "../../../experience-prototypes/scripts/credentials";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { evaluate, GatewayError } from "../../jev-client/src/index";
import { bankSchema, type Item } from "../src/checkable/items";

const key = process.env.AI_GATEWAY_API_KEY;

if (!key) throw Error("Set AI_GATEWAY_API_KEY to record.");

const out = new URL("../recordings/decompose.jsonl", import.meta.url);

const bank = bankSchema.parse(
  JSON.parse(readFileSync(new URL("../src/checkable/bank.json", import.meta.url), "utf8")),
);

const tetris = bank.items.filter((i) => i.kind === "tetris").slice(0, 30);
const grid = bank.items.filter((i) => i.kind === "grid").slice(0, 30);
const LANDINGS = ["A", "B", "C"];
const PAIRS = [
  ["A", "B"],
  ["A", "C"],
  ["B", "C"],
];

function questionsFor(item: Item) {
  if (item.kind === "tetris")
    return Object.fromEntries([
      ...PAIRS.map(([x, y]) => [
        `lower_${x}${y}`,
        {
          type: "noul",
          instructions: `In landing ${x} the piece (the @ cells) is drawn lower on the board than in landing ${y}.`,
        },
      ]),
      ...LANDINGS.map((x) => [
        `gap_${x}`,
        {
          type: "noul",
          instructions: `In landing ${x}, at least one empty cell (.) sits directly below one of the piece's @ cells.`,
        },
      ]),
    ]);

  return {
    exit_without_door: {
      type: "noul",
      instructions: "The agent can reach the exit E without ever stepping onto the door D.",
    },
    key_without_door: {
      type: "noul",
      instructions: "The agent can reach the key K without ever stepping onto the door D.",
    },
    exit_from_key: {
      type: "noul",
      instructions:
        "Starting from the key K, and allowed to walk through the door D, one can reach the exit E.",
    },
  };
}

const done = new Set<string>();

if (existsSync(out))
  for (const line of readFileSync(out, "utf8").split("\n"))
    if (line.trim()) {
      const r: { id?: string; status?: string } = JSON.parse(line);

      if (r.id && r.status === "ok") done.add(r.id);
    }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const item of [...tetris, ...grid]) {
  if (done.has(item.id)) continue;
  let backoff = 2000;

  for (;;) {
    try {
      // SAFETY: questionsFor builds only native noul questions, the gateway's wire shape.
      const r = await evaluate(
        { state: item.state, questions: questionsFor(item) as never },
        { apiKey: key, maxAttempts: 1, deadlineMs: 20_000 },
      );

      appendFileSync(
        out,
        `${JSON.stringify({ id: item.id, status: "ok", latencyMs: r.service_latency_ms, answers: r.answers })}\n`,
      );
      break;
    } catch (error) {
      const status = error instanceof GatewayError ? error.status : 0;

      if (status !== 429 && status !== 503 && status !== 0) throw error;
      await wait(backoff);
      backoff = Math.min(30_000, backoff * 2);
    }
  }

  await wait(700);
}

// ---------------------------------------------------------------- compare

type Row = {
  id: string;
  status: string;
  answers: Record<
    string,
    { value: string | number; probabilities?: Record<string, number> | null }
  >;
};

const read = (text: string) =>
  new Map(
    text
      .split("\n")
      .filter((l) => l.trim())
      .map((l): Row => JSON.parse(l))
      .filter((r) => r.status === "ok")
      .map((r) => [r.id, r]),
  );

const single = read(
  gunzipSync(readFileSync(new URL("../recordings/checkable.jsonl.gz", import.meta.url))).toString(
    "utf8",
  ),
);
const split = read(readFileSync(out, "utf8"));
const yes = (r: Row, q: string) => Number(r.answers[q]?.value ?? 0.5);
const top = (p: Record<string, number>) =>
  Object.entries(p).reduce((a, b) => (b[1] > a[1] ? b : a))[0];

const tally = {
  lowSingle: 0,
  lowSplit: 0,
  holeSingle: 0,
  holeSplit: 0,
  exitSingle: 0,
  exitSplit: 0,
};

for (const item of tetris) {
  const s = single.get(item.id);
  const d = split.get(item.id);

  if (!s || !d) continue;
  const wins: Record<string, number> = { A: 0, B: 0, C: 0 };

  for (const [x, y] of PAIRS) {
    const p = yes(d, `lower_${x}${y}`);

    wins[x] += p;
    wins[y] += 1 - p;
  }

  const gaps = Object.fromEntries(LANDINGS.map((x) => [x, -yes(d, `gap_${x}`)]));

  tally.lowSingle += Number(
    String(s.answers.lowest_stack?.value) === String(item.truth.lowest_stack),
  );
  tally.lowSplit += Number(top(wins) === String(item.truth.lowest_stack));
  tally.holeSingle += Number(
    String(s.answers.fewest_holes?.value) === String(item.truth.fewest_holes),
  );
  tally.holeSplit += Number(top(gaps) === String(item.truth.fewest_holes));
}

for (const item of grid) {
  const s = single.get(item.id);
  const d = split.get(item.id);

  if (!s || !d) continue;
  const p1 = yes(d, "exit_without_door");
  const p = p1 + (1 - p1) * yes(d, "key_without_door") * yes(d, "exit_from_key");

  tally.exitSingle += Number(yes(s, "can_exit") >= 0.5 === item.truth.can_exit);
  tally.exitSplit += Number(p >= 0.5 === item.truth.can_exit);
}

const pct = (n: number, of: number) => `${((n / of) * 100).toFixed(0)}% (${n}/${of})`;

console.log(
  `Tetris lowest stack   single ${pct(tally.lowSingle, tetris.length)}   split ${pct(tally.lowSplit, tetris.length)}`,
);
console.log(
  `Tetris fewest holes   single ${pct(tally.holeSingle, tetris.length)}   split ${pct(tally.holeSplit, tetris.length)}`,
);
console.log(
  `Grid can reach exit   single ${pct(tally.exitSingle, grid.length)}   split ${pct(tally.exitSplit, grid.length)}`,
);
