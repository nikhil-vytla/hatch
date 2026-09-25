/**
 * Replays Shapeshift's own keyword classifier over the development phrases (never the held-out
 * ones): a harness check that needs no key. Usage: bun packages/arena/scripts/shapeshift-keyword.ts
 */
import { readFileSync } from "node:fs";
import { phrasesSchema } from "../src/shapeshift/phrases";
import { outcome, replay, type Policy } from "../src/shapeshift/replay";
import { mockClassify } from "../src/shapeshift/upstream/jev/mock";

const doc = phrasesSchema.parse(
  JSON.parse(readFileSync(new URL("../src/shapeshift/phrases.json", import.meta.url), "utf8")),
);

const dev = doc.phrases.filter((p) => p.split === "dev");
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

for (const policy of ["cancel", "latest"] satisfies Policy[]) {
  const rows = dev.map((p) => ({
    p,
    o: outcome(
      replay(p.text, (key) => ({ result: mockClassify(key), latencyMs: 1 }), policy),
      p,
    ),
  }));

  const by = (kind?: string) => {
    const rs = kind ? rows.filter((r) => r.p.kind === kind) : rows;
    const times = rs.flatMap((r) => (r.o.timeToRight === undefined ? [] : [r.o.timeToRight]));

    return `${String(rs.length).padStart(3)} phrases · final right ${(mean(rs.map((r) => Number(r.o.finalRight))) * 100).toFixed(1)}% · wrong commits ${mean(rs.map((r) => r.o.wrongCommits)).toFixed(2)} · changes ${mean(rs.map((r) => r.o.changes)).toFixed(2)} · right for good at ${Math.round(mean(times))} ms (${times.length} reach it)`;
  };

  console.log(`\nkeyword classifier, ${policy} policy`);
  for (const kind of [undefined, "plain", "ambiguous", "adversarial"])
    console.log(`  ${(kind ?? "all").padEnd(11)} ${by(kind)}`);
}
