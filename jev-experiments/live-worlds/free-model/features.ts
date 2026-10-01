/**
 * Featurisation for the free model, shared by training (Node) and play (the browser worker), so
 * both see identical inputs. Text goes through all-MiniLM-L6-v2 (mean-pooled, normalised, q8),
 * the model the rumour mill already downloads; everything else is a small one-hot.
 */
import type { MessageKind, Profile } from "../rumour/profiles";
import { ARCHETYPES } from "../rumour/town";
import type { Event } from "../win-over/decide";

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

export const DIM = 384;

export const INTENTS = ["greeting", "joke", "gift", "request", "bribe", "lie", "threat"] as const;

export const ACTIONS_WO = ["approach", "avoid", "gossip", "come", "carry_on"] as const;

export const KINDS = ["say", "cake", "notice"] as const;

export const TEMPERS = ["trusting and warm", "sceptical of strangers", "shy", "chatty", "easily offended", "hard to impress"] as const;

export const LIKES = ["music", "books", "cake", "plants", "gossip", "quiet", "dancing", "chess", "coffee", "art", "football", "birds"] as const;

export const GOAL_IDS = ["gig", "cake", "trust"] as const;

export const SAYS = ["the newcomer is lovely", "the newcomer seems nice", "the newcomer is rude", "the newcomer is a fraud", "the newcomer threatened people"] as const;

export const RUMOUR_ACTIONS = ["ignore", "share", "go", "argue"] as const;

export const SOURCES = ["noticeboard", "neighbour", "hub"] as const;

const oneHot = (n: number, i: number) => Array.from({ length: n }, (_, j) => (j === i ? 1 : 0));

/** The text embedded for a Win over event: what kind of thing happened, then the words. */
export const eventText = (e: Event) =>
  e.kind === "notice" ? `A notice says: ${e.text}` : e.kind === "cake" ? `Gives you cake and says: ${e.text || "(nothing)"}` : `Says: ${e.text}`;

export const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;

  for (let i = 0; i < a.length; i++) s += a[i] * b[i];

  return s;
};

/** Line model input: the embedding and the kind of event. */
export const lineInput = (emb: ArrayLike<number>, e: Event) => [...Array.from(emb), ...oneHot(KINDS.length, KINDS.indexOf(e.kind))];

export type Persona = { temper: string; likes: string[]; mood: number };

/**
 * Reaction model input: the line's embedding, the line model's own judgments, and the resident:
 * temper, mood, the goal, and how close the line is to each thing they like.
 */
export function reactionInput(emb: ArrayLike<number>, e: Event, line: number[], p: Persona, goalId: string, likeVectors: Record<string, ArrayLike<number>>) {
  const likeSims = LIKES.map((l) => (p.likes.includes(l) ? dot(emb, likeVectors[l]) : 0));

  return [
    ...Array.from(emb),
    ...oneHot(KINDS.length, KINDS.indexOf(e.kind)),
    ...line,
    ...oneHot(TEMPERS.length, TEMPERS.indexOf(p.temper as (typeof TEMPERS)[number])),
    ...LIKES.map((l) => (p.likes.includes(l) ? 1 : 0)),
    ...likeSims,
    ...oneHot(5, Math.max(0, Math.min(4, p.mood))),
    ...oneHot(GOAL_IDS.length, GOAL_IDS.indexOf(goalId as (typeof GOAL_IDS)[number])),
  ];
}

/** Rumour model input for one profile: the message (and, for a correction, the rumour) plus who they are. */
export function profileInput(msg: ArrayLike<number>, rumour: ArrayLike<number> | null, kind: MessageKind, p: Profile, hasPlace: boolean) {
  return [
    ...Array.from(msg),
    ...(rumour ? Array.from(rumour) : new Array<number>(DIM).fill(0)),
    kind === "counter" ? 1 : 0,
    hasPlace ? 1 : 0,
    ...oneHot(ARCHETYPES.length, ARCHETYPES.findIndex((a) => a.id === p.archetype)),
    p.trusting ? 1 : 0,
    ...oneHot(SOURCES.length, SOURCES.indexOf(p.source)),
    p.believed === undefined ? 0 : p.believed ? 1 : -1,
  ];
}
