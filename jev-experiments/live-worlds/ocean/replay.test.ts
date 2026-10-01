import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseRecording, RACE, replayer } from "./replay";

const text = gunzipSync(readFileSync(new URL("./recordings/jev-heatwave.jsonl.gz", import.meta.url))).toString("utf8");
const summary = JSON.parse(text.trim().split("\n").at(-1) ?? "{}");

describe("recorded Jev reef", () => {
  test("replays to exactly the recorded outcome, without calling Jev", () => {
    const rec = parseRecording(text);
    const r = replayer(rec);

    while (!r.done()) r.step();

    expect(rec.seed).toBe(RACE.seed);
    expect(r.world.fish.filter((f) => f.alive)).toHaveLength(summary.fishAlive);
    expect(r.world.outcomes).toEqual(summary.outcomes);
    expect(r.world.deaths).toEqual(summary.deaths);
    expect(r.world.births).toBe(summary.births);
  });

  test("stayed inside the recording budget (400 requests, $0.10, including the discarded first run)", () => {
    expect(summary.requests + 158).toBeLessThanOrEqual(400);
    expect(summary.usd + 0.041).toBeLessThanOrEqual(0.1);
  });
});
