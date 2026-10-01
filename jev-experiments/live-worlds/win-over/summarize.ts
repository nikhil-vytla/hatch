/**
 * Rebuilds recorded.json (the page's two-model table) from recordings.jsonl, without calling a
 * model. The verdict is written by hand from the rows and kept across rebuilds.
 *
 *   bun live-worlds/win-over/summarize.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Decision = { intent?: string; intentP?: number; action?: string };
type Row = {
  line: { kind: string; text: string };
  listeners: { name: string; temper: string }[];
  mobilebert: { ms: number; decisions: Decision[] };
  jev: { ms: number; inputTokens: number; decisions: Decision[] };
};

const PAST: Record<string, string> = {
  approach: "came over",
  avoid: "steered clear",
  gossip: "went to tell someone",
  come: "said they'd come",
  carry_on: "carried on",
};

export function tally(ds: Decision[]) {
  const counts = new Map<string, number>();

  for (const d of ds) counts.set(d.action ?? "carry_on", (counts.get(d.action ?? "carry_on") ?? 0) + 1);

  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `${n} ${PAST[a] ?? a}`)
    .join(", ");
}

const intent = (d: Decision | undefined) => `${d?.intent ?? "—"} (${Math.round((d?.intentP ?? 0) * 100)}%)`;

const dir = new URL("./", import.meta.url);
const rows: Row[] = readFileSync(new URL("recordings.jsonl", dir), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const target = new URL("recorded.json", dir);
const verdict = existsSync(target) ? JSON.parse(readFileSync(target, "utf8")).verdict ?? "" : "";
const ms = rows.map((r) => r.jev.ms).sort((a, b) => a - b);

writeFileSync(
  target,
  JSON.stringify(
    {
      recordedOn: (rows[0] as unknown as { at: string }).at.slice(0, 10),
      listeners: rows[0].listeners.map((l) => `${l.name} (${l.temper})`),
      jev: {
        calls: rows.length,
        medianMs: ms[Math.floor(ms.length / 2)],
        costUsd: rows.reduce((s, r) => s + (r.jev.inputTokens * 0.042) / 1e6, 0),
      },
      lines: rows.map((r) => ({
        text: r.line.text,
        kind: r.line.kind,
        mobilebert: { intent: intent(r.mobilebert.decisions[0]), actions: tally(r.mobilebert.decisions) },
        jev: { intent: intent(r.jev.decisions[0]), actions: tally(r.jev.decisions) },
      })),
      verdict,
    },
    null,
    2,
  ) + "\n",
);
