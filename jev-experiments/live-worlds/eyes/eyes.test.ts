import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initial } from "../../local-models-and-games/arcade/engine";
import { png } from "./frame";
import { apply, pick, relative, type FrameRecord } from "./model";
import { greedyLane, vlmLane } from "./summary";

const rows = (name: string): FrameRecord[] =>
  readFileSync(new URL(`./recordings/${name}.jsonl`, import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

describe("eyes against state", () => {
  test("an absolute direction becomes the engine's relative move from the heading", () => {
    // Heading 1 is right.
    expect(relative(1, "right")).toBe("straight");
    expect(relative(1, "down")).toBe("right");
    expect(relative(1, "up")).toBe("left");
    expect(relative(1, "left")).toBe("reverse");
    expect(relative(0, "left")).toBe("left");
  });

  test("turning back into the neck ends the game", () => {
    const s = apply(initial("snake", 101), "reverse");

    expect(s.status).toBe("lost");
    expect(s.tick).toBe(1);
  });

  test("pick takes the most probable direction", () => {
    expect(pick({ up: 0.1, right: 0.6, down: 0.2, left: 0.1 })).toBe("right");
  });

  test("the recorded frames are the frames this code draws", () => {
    const r = rows("qwen3-vl-4b.v1").find((x) => x.seed === 101 && x.tick === 0);

    expect(r?.frame_sha256).toBe(png(initial("snake", 101)).sha256);
  });

  test("replaying a recording reaches every recorded frame and ends where the recorder stopped", () => {
    const recorded = rows("qwen3-vl-4b.v1");
    const lane = vlmLane("t", "t", recorded);

    // Every game is replayed, and every recorded move is used: no gaps, no extra frames.
    expect(lane.games.length).toBe(new Set(recorded.map((r) => r.seed)).size);
    expect(lane.games.reduce((n, g) => n + g.moves, 0)).toBe(recorded.length);
  });

  test("the greedy rule's facts lane is deterministic", () => {
    expect(greedyLane([101, 102])).toEqual(greedyLane([101, 102]));
  });
});
