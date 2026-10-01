/**
 * Writes the teacher's labelling jobs: synthetic game situations, each as the exact request the
 * game builds at play time. One change for the teacher only: the yes/no "honest" and "friendly"
 * questions carry spelled-out options, because without them Qwen answers "honest" yes to every
 * line, boasts included.
 *
 *   bun live-worlds/free-model/gen.ts OUT_DIR
 *
 * Splits hold out whole templates (and, for reactions, whole personas), not just rows.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { allProfiles, jevRequest } from "../rumour/profiles";
import { gossipRequest, reactionRequest } from "../win-over/decide";
import { createWorld, GOALS, LIKES, TEMPERS, type Rumour } from "../win-over/engine";
import { fill, fillRumour, lineTemplates, rumourTemplates } from "./banks";
import { teacherLineRequest } from "./teacher-requests";

const out = process.argv[2] ?? "free-model-jobs";

mkdirSync(out, { recursive: true });

/** A small seeded generator, so the jobs are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;

  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);

/** One in five templates (and personas) is held out for validation. */
export const heldOut = (key: string) => hash(key) % 5 === 0;

const write = (name: string, rows: unknown[]) => {
  writeFileSync(join(out, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`${name}: ${rows.length}`);
};

// ---------- Who can you win over? ----------

const rand = rng(20260930);
const templates = lineTemplates();
const lines = new Map<string, { template: string; intent: string; event: Event }>();

// Neutral openers and closers add surface variety without changing what a line means.
const OPEN = ["", "", "", "Well, ", "So, ", "Oh, ", "By the way, ", "Listen, ", "Right, "];
const CLOSE = ["", "", "", " Cheers.", " Anyway.", " Ha.", " :)", " See you."];

for (let round = 0; round < 60; round++)
  for (const t of templates) {
    const body = fill(t.text, rand);
    const open = t.kind === "say" && body ? OPEN[Math.floor(rand() * OPEN.length)] : "";
    const close = t.kind === "say" && body ? CLOSE[Math.floor(rand() * CLOSE.length)] : "";
    // "I", names and all-caps words keep their capital after an opener.
    const keep = /^(I\b|I'|[A-Z]{2}|[A-Z][a-z]+\b(?! (?:is|was|are)\b))/.test(body) && !/^(Hi|Hello|Hey|Good|Morning|Afternoon|Oh|Why|What|My|Fun|Never|Could|Please|Would|Do|Can|Fancy|Come|Here|Take|This|Thanks|Just|Freshly|Cake|How|Say|Put|Have|Everyone|The|Nice|Stay|If|Don't|Laugh|Move|Be|A)\b/.test(body);
    const lead = keep ? body : body.charAt(0).toLowerCase() + body.slice(1);
    const text = open ? open + lead + close : body + close;
    const key = `${t.kind}|${text}`;

    if (!lines.has(key)) lines.set(key, { template: t.id, intent: t.intent, event: { kind: t.kind, text } });
  }

const lineRows = [...lines.values()].map((l, i) => ({
  id: `line-${i}`,
  template: l.template,
  bankIntent: l.intent,
  split: heldOut(l.template) ? "val" : "train",
  event: l.event,
  request: teacherLineRequest(l.event),
}));

write("wo-lines.jsonl", lineRows);

// Residents from the game's own generator, so names and likes look like play.
const people = createWorld(11, 48).residents;
const personaKey = (temper: string, likes: string[]) => `${temper}|${[...likes].sort().join("+")}`;
const reactionRows = [];

for (let i = 0; i < 3200; i++) {
  const line = lineRows[Math.floor(rand() * lineRows.length)];
  const base = people[Math.floor(rand() * people.length)];
  const temper = TEMPERS[Math.floor(rand() * TEMPERS.length)];
  const likes = [LIKES[Math.floor(rand() * LIKES.length)], LIKES[Math.floor(rand() * LIKES.length)]].filter((x, j, xs) => xs.indexOf(x) === j);
  const mood = Math.floor(rand() * 5);
  const g = GOALS[Math.floor(rand() * GOALS.length)];
  const r = { ...base, temper, likes, mood };
  const persona = personaKey(temper, likes);

  reactionRows.push({
    id: `react-${i}`,
    template: line.template,
    persona,
    split: heldOut(line.template) || heldOut(persona) ? "val" : "train",
    event: line.event,
    resident: { name: r.name, temper, likes, mood },
    goal: g.id,
    request: reactionRequest(r, line.event, g),
  });
}

write("wo-reactions.jsonl", reactionRows);

// Gossip is a small closed set (temper × mood × what the rumour says): label all of it.
const SAYS = ["the newcomer is lovely", "the newcomer seems nice", "the newcomer is rude", "the newcomer is a fraud", "the newcomer threatened people"];
const gossipRows = [];

for (const temper of TEMPERS)
  for (let mood = 0; mood < 5; mood++)
    for (const says of SAYS)
      for (const [li, ti] of [
        [0, 1],
        [2, 3],
      ]) {
        const listener = { ...people[li], temper, mood };
        const teller = people[ti];
        const rumour: Rumour = { id: 1, tone: says.includes("lovely") || says.includes("nice") ? "warm" : "cold", says, from: teller.name, origin: teller.name };

        gossipRows.push({
          id: `gossip-${gossipRows.length}`,
          temper,
          mood,
          says,
          split: "train",
          request: gossipRequest({ listener, teller, rumour }),
        });
      }

write("wo-gossip.jsonl", gossipRows);

// ---------- The rumour mill ----------

const rrand = rng(42);
const rumourRows = [];
const counterRows = [];
const seen = new Set<string>();

for (let round = 0; round < 14; round++)
  for (const t of rumourTemplates()) {
    const { text, counter } = fillRumour(t, rrand);

    if (seen.has(text)) continue;

    seen.add(text);

    const split = heldOut(t.id) ? "val" : "train";
    const rumour = allProfiles("rumour");

    rumourRows.push({
      id: `rumour-${rumourRows.length}`,
      template: t.id,
      group: t.group,
      split,
      kind: "rumour",
      text,
      place: t.place,
      profiles: rumour.map((p) => p.key),
      request: jevRequest(rumour, "rumour", text, null, t.place),
    });

    // A correction for one rumour in three keeps the counter set smaller than the rumour set.
    if (round % 3 === 0) {
      const counterProfiles = allProfiles("counter");

      counterRows.push({
        id: `counter-${counterRows.length}`,
        template: t.id,
        group: t.group,
        split,
        kind: "counter",
        text: counter,
        rumour: text,
        place: null,
        profiles: counterProfiles.map((p) => p.key),
        request: jevRequest(counterProfiles, "counter", counter, text, null),
      });
    }
  }

write("rm-rumours.jsonl", rumourRows);
write("rm-counters.jsonl", counterRows);
