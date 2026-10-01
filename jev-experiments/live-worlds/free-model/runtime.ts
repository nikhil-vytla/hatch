/**
 * The free model at play time. Text is embedded once (MiniLM, in a worker); these small
 * networks then answer every question for every listener in about a millisecond. Trained on an
 * open-weights teacher (Qwen3.8-2.4T-A95B), never on Jev.
 *
 * Who can you win over? uses it. The rumour-mill network (profileDists) was trained and scored
 * too, but it didn't beat that page's current free model on the gold rumours, so the page keeps
 * its similarity formula; see README.
 */
import { allProfiles, type Dist, type MessageKind } from "../rumour/profiles";
import type { PlaceId as RumourPlace } from "../rumour/town";
import type { Answer, Event } from "../win-over/decide";
import type { Goal, Meeting, Resident } from "../win-over/engine";
import { lineInput, profileInput, reactionInput, RUMOUR_ACTIONS } from "./features";
import { load, run, type NetFile } from "./model";
import gossipTable from "./weights/gossip-table.json";
import likeVectors from "./weights/like-vectors.json";
import lineFile from "./weights/line.json";
import profileFile from "./weights/profile.json";
import reactionFile from "./weights/reaction.json";

export const STUDENT_NAME = "Bramble mini";

// SAFETY: the weight files are written by train.py in NetFile's shape.
const nets = {
  line: load(lineFile as NetFile),
  reaction: load(reactionFile as NetFile),
  profile: load(profileFile as NetFile),
};

/** Committed size of the trained parts, in bytes of float32 weights. */
export const WEIGHT_BYTES = Object.values(nets).reduce(
  (s, n) => s + 4 * (n.hidden.w.length + n.hidden.b.length + Object.values(n.heads).reduce((t, h) => t + h.layer.w.length + h.layer.b.length, 0)),
  0,
);

// ---------- Who can you win over? ----------

/** The line's own judgments: what kind of message, honest, friendly. */
export function judgeLine(emb: ArrayLike<number>, e: Event): Record<string, Answer> {
  const o = run(nets.line, lineInput(emb, e));

  return { intent: { probabilities: o.intent }, honest: { value: o.honest.true }, friendly: { value: o.friendly.true } };
}

/** The line model's outputs as the reaction model reads them. */
export function lineVector(a: Record<string, Answer>) {
  // SAFETY: judgeLine always sets these three answers in these shapes.
  const p = a.intent.probabilities as Record<string, number>;

  return [...Object.values(p), Number(a.honest.value), Number(a.friendly.value)];
}

/** One listener's reaction: do they like it, and what do they do next? */
export function judgeReaction(emb: ArrayLike<number>, e: Event, line: Record<string, Answer>, r: Resident, g: Goal): Record<string, Answer> {
  const o = run(nets.reaction, reactionInput(emb, e, lineVector(line), r, g.id, likeVectors));

  return { warmer: { value: o.warmer.true }, action: { probabilities: o.action } };
}

/** Gossip: a lookup over every temper × mood × what the rumour says, as the teacher answered it. */
export function judgeGossip(m: Meeting): Record<string, Answer> {
  const table: Record<string, number[]> = gossipTable;
  const [believes, passOn] = table[`${m.listener.temper}|${m.listener.mood}|${m.rumour.says}`] ?? [0.5, 0.5];

  return { believes: { value: believes }, passOn: { value: passOn } };
}

// ---------- The rumour mill ----------

/** Every profile's odds for one message (and, for a correction, the rumour it corrects). */
export function profileDists(msg: ArrayLike<number>, rumour: ArrayLike<number> | null, kind: MessageKind, place: RumourPlace | null) {
  const hasPlace = kind === "rumour" && !!place;
  const mask = { action: hasPlace ? [] : ["go"] };

  return new Map(
    allProfiles(kind).map((p) => {
      const o = run(nets.profile, profileInput(msg, kind === "counter" ? rumour : null, kind, p, hasPlace), mask).action;
      const d = Object.fromEntries(RUMOUR_ACTIONS.map((a) => [a, o[a] ?? 0]));

      // SAFETY: d has exactly the four rumour actions.
      return [p.key, d as Dist];
    }),
  );
}
