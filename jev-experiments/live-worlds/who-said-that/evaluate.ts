/**
 * Scores the decisions against the corpus transcript, for every scenario in a folder that has
 * <id>.signals.json and <id>.truth.json (and, if recorded, <id>.jev.json).
 *
 *   bun live-worlds/who-said-that/evaluate.ts [dir] [--json out.json]
 *
 * With no dir it scores the published scenarios in experience-prototypes/public/who-said-that/.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALL_ON, counts, decide, hindsight, type Weights } from "./decide";
import { freeAnswers, type TextAnswers } from "./questions";
import { score, type Truth } from "./score";
import type { Heard } from "./signals";

export type Lane = "free" | "jev";

export function run(heard: Heard[], text: TextAnswers[], truth: Truth, w: Weights = ALL_ON) {
  const s = decide(heard, text, w);
  const late = hindsight(s, heard, w);
  const online = s.lines.map((l) => ({ who: l.who, conv: l.conv, topic: l.topic }));
  const revised = s.lines.map((l, k) => ({ who: late[k].who, conv: late[k].conv, topic: l.topic }));

  return { counts: counts(s), truth: truth.counts, online: score(truth, heard, online), revised: score(truth, heard, revised) };
}

const pct = (x: { share: number }) => `${Math.round(x.share * 100)}%`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dir = args[0] && !args[0].startsWith("--") ? args[0] : new URL("../../experience-prototypes/public/who-said-that/", import.meta.url).pathname;
  const jsonAt = args.indexOf("--json");
  const results: Record<string, unknown> = {};

  for (const f of readdirSync(dir).filter((f) => f.endsWith(".signals.json"))) {
    const id = f.replace(".signals.json", "");
    const heard: Heard[] = JSON.parse(readFileSync(join(dir, f), "utf8")).heard;
    const truth: Truth = JSON.parse(readFileSync(join(dir, `${id}.truth.json`), "utf8"));
    const lanes: Partial<Record<Lane, TextAnswers[]>> = { free: freeAnswers(heard) };
    const jevPath = join(dir, `${id}.jev.json`);

    if (existsSync(jevPath)) lanes.jev = JSON.parse(readFileSync(jevPath, "utf8")).answers;

    results[id] = {};

    for (const [lane, text] of Object.entries(lanes)) {
      const r = run(heard, text!, truth);

      (results[id] as Record<string, unknown>)[lane] = r;
      console.log(
        `${id.padEnd(16)} ${lane.padEnd(4)} speakers ${r.counts.speakers}/${r.truth.speakers} conv ${r.counts.conversations}/${r.truth.conversations} topics ${r.counts.topics}/${r.truth.topics}` +
          ` | words ${r.online.words}, missed ${r.online.missed} | online spk ${pct(r.online.speaker)} conv ${pct(r.online.conversation)} topic ${pct(r.online.topic)}` +
          ` | hindsight spk ${pct(r.revised.speaker)} conv ${pct(r.revised.conversation)}`,
      );
    }
  }

  if (jsonAt >= 0) writeFileSync(args[jsonAt + 1], JSON.stringify(results, null, 1) + "\n");
}
