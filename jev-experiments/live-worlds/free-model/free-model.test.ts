import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { allProfiles } from "../rumour/profiles";
import { Brain } from "../win-over/brain";
import { createWorld, goal, startGoal, TEMPERS } from "../win-over/engine";
import { DIM, INTENTS, lineInput, profileInput, reactionInput, SAYS } from "./features";
import goldLines from "./gold/win-over-lines.json";
import { load, run, top, type NetFile } from "./model";
import results from "./results.json";
import { judgeGossip, judgeLine, WEIGHT_BYTES } from "./runtime";
import { PROFILE_WEIGHT_BYTES, profileDists } from "./runtime-rumour";
import likeVectors from "./weights/like-vectors.json";

const weights = (name: string) => JSON.parse(readFileSync(new URL(`./weights/${name}.json`, import.meta.url), "utf8")) as NetFile;
const checks = (name: string) =>
  JSON.parse(readFileSync(new URL(`./weights/${name}.checks.json`, import.meta.url), "utf8")) as {
    x: number[];
    out: Record<string, Record<string, number>>;
    mask?: Record<string, string[]>;
  }[];
const gold = JSON.parse(readFileSync(new URL("./gold/embeddings.json", import.meta.url), "utf8")) as { lines: string[]; rumours: string[] };
const vec = (b64: string) => new Float32Array(new Uint8Array(Buffer.from(b64, "base64")).buffer);

const zeros = new Array<number>(DIM).fill(0);
const say = { kind: "say" as const, text: "hi" };

describe("free model featurisation", () => {
  test("each input is the length its network was trained on", () => {
    const p = allProfiles("counter")[0];

    expect(lineInput(zeros, say).length).toBe(weights("line").input);
    expect(reactionInput(zeros, say, new Array(9).fill(0), { temper: TEMPERS[0], likes: ["music"], mood: 2 }, "gig", likeVectors).length).toBe(
      weights("reaction").input,
    );
    expect(profileInput(zeros, zeros, "counter", p, false).length).toBe(weights("profile").input);
  });

  test("a resident's likes only count for things they like", () => {
    const x = reactionInput(zeros.map(() => 1 / Math.sqrt(DIM)), say, new Array(9).fill(0), { temper: TEMPERS[0], likes: ["music"], mood: 2 }, "gig", likeVectors);
    // The 12 similarity features follow the 12 like flags; only "music" (the first) is non-zero.
    const sims = x.slice(DIM + 3 + 9 + 6 + 12, DIM + 3 + 9 + 6 + 24);

    expect(sims.filter((s) => s !== 0)).toHaveLength(1);
  });
});

describe("free model inference", () => {
  for (const name of ["line", "reaction", "profile"]) {
    test(`${name}: TypeScript matches the trainer's outputs`, () => {
      const net = load(weights(name));

      for (const c of checks(name)) {
        const out = run(net, c.x, c.mask ?? {});

        for (const [head, dist] of Object.entries(c.out)) for (const [k, v] of Object.entries(dist)) expect(out[head][k]).toBeCloseTo(v, 4);
      }
    });
  }

  test("'go' is never chosen when the message names no place", () => {
    for (const d of profileDists(vec(gold.rumours[0]), null, "rumour", null).values()) expect(d.go).toBe(0);
  });

  test("the gossip table covers every temper, mood and rumour", () => {
    const people = createWorld(3, 2).residents;

    for (const temper of TEMPERS)
      for (let mood = 0; mood < 5; mood++)
        for (const says of SAYS) {
          const a = judgeGossip({ listener: { ...people[0], temper, mood }, teller: people[1], rumour: { id: 1, tone: "warm", says, from: "x", origin: "x" } });

          expect(typeof a.believes.value).toBe("number");
        }
  });

  test("the trained weights stay small", () => {
    expect(WEIGHT_BYTES + PROFILE_WEIGHT_BYTES).toBeLessThan(1_000_000);
  });
});

describe("the student in the game", () => {
  test("Win over applies the student's decisions to everyone in earshot", async () => {
    const w = createWorld(5);

    startGoal(w, "gig");

    const listeners = w.residents.slice(0, 4);
    const brain = new Brain(() => w, { kind: "student", name: "test", embed: async () => vec(gold.lines[0]) });

    brain.hear({ kind: "say", text: "Hello! Lovely to meet you." }, listeners);

    for (let i = 0; i < 20 && brain.pending; i++) await new Promise((r) => setTimeout(r, 5));

    expect(w.stats.decisions).toBe(4);
    expect(listeners.every((r) => r.last?.model === "test" && !r.busy)).toBe(true);
    expect(goal("gig").place).toBe("stage");
  });
});

describe("gold-set scores are reproducible", () => {
  test("re-scoring the student from the saved embeddings matches results.json", () => {
    const lines = goldLines.lines;
    const intent = lines.filter((l, i) => {
      const a = judgeLine(vec(gold.lines[i]), { kind: l.kind as "say", text: l.text });

      // SAFETY: judgeLine returns a probability map for intent.
      return top(a.intent.probabilities as Record<string, number>)[0] === l.intent;
    }).length;

    expect(Math.round((1000 * intent) / lines.length) / 1000).toBe(results.winOver.results.student.intent.accuracy);

    expect(INTENTS).toHaveLength(7);
  });
});
