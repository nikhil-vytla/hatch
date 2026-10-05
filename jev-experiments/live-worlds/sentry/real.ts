/**
 * The openly licensed rows from data/real.jsonl (see data/SOURCES.md) as training examples. Real
 * datasets give text and an injection label only, so each row trains the risk head alone. Every
 * real row is placed as visible text: the sources say nothing about placement, and putting their
 * injections in hidden places taught the model that comments and alt text are attacks (the first
 * retrain flagged harmless comments and photo captions). Placement is learned from the authored
 * families, which have harmless hidden blocks too. Gandalf's ~1,000 near-identical "ignore all
 * previous" lines are subsampled so they don't swamp the other sources. Node only.
 */
import { readFileSync } from "node:fs";
import type { Example } from "./dataset";
import { fnv1aUnit } from "../../packages/seeded/src/index";

export type RealRow = { text: string; injection: boolean; source: string; split: "train" | "test" };

const hashed = (s: string) => fnv1aUnit(s, 0x9e3779b9);

/** Share of each source's training rows kept; test splits are always kept whole. */
const KEEP: Record<string, number> = { gandalf: 0.2 };

export function realRows(): RealRow[] {
  return readFileSync(new URL("./data/real.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as RealRow)
    .filter((r) => r.split === "test" || hashed(r.text) < (KEEP[r.source] ?? 1));
}

export function toExample(r: RealRow): Example {
  return {
    text: r.text,
    where: "visible",
    family: `real:${r.source}`,
    template: r.split === "test" ? 3 : 0,
    source: r.source,
    labels: { risk: r.injection ? 1 : 0 },
  };
}
