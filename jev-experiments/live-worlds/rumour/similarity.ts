/**
 * The free model: a small sentence-embedding model (all-MiniLM-L6-v2) in the visitor's browser.
 * It doesn't decide anything. It measures how close the message is to a few reference sentences
 * (believable news, a scam, a joke, an invitation, a warning) and to each archetype's
 * description; a fixed formula turns those similarities and the profile's traits into odds for
 * the four actions. That makes it similarity plus hand-set weights, and the page says so.
 */
import { ACTIONS, type Dist, type MessageKind, type Profile } from "./profiles";
import { ARCHETYPES, PLACES, type ArchetypeId, type PlaceId } from "./town";

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

export const ANCHORS = {
  credible: "A neighbour passes on ordinary, believable local news.",
  scam: "An obvious scam asking for money, a PIN or bank details.",
  joke: "A silly joke or an absurd conspiracy theory.",
  invite: "An invitation to come to a place in town today.",
  warning: "An urgent warning about a closure, a danger or a problem.",
} as const;

export type AnchorId = keyof typeof ANCHORS;

export type Vectors = {
  anchors: Record<AnchorId, number[]>;
  archetypes: Record<ArchetypeId, number[]>;
  places: Record<PlaceId, number[]>;
};

export const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);

export type Features = {
  /** Believable news minus the closer of scam and joke. */
  credible: number;
  invite: number;
  warning: number;
  /** How much the message is about each archetype's interests, relative to the others. */
  interest: Record<ArchetypeId, number>;
  /** The place it invites people to, if it reads as an invitation. */
  place: PlaceId | null;
  raw: Record<AnchorId, number>;
};

/** Similarities for one message. Vectors are unit length, so dot = cosine. */
export function features(message: number[], v: Vectors): Features {
  const raw = Object.fromEntries(Object.entries(v.anchors).map(([k, a]) => [k, dot(message, a)])) as Record<AnchorId, number>;
  const mean = Object.values(raw).reduce((s, x) => s + x, 0) / Object.values(raw).length;
  const sims = ARCHETYPES.map((a) => dot(message, v.archetypes[a.id]));
  const simMean = sims.reduce((s, x) => s + x, 0) / sims.length;
  const placeSims = PLACES.map((p) => [p.id, dot(message, v.places[p.id])] as const).sort((a, b) => b[1] - a[1]);
  const invite = raw.invite - mean;

  return {
    credible: raw.credible - Math.max(raw.scam, raw.joke),
    invite,
    warning: raw.warning - mean,
    interest: Object.fromEntries(ARCHETYPES.map((a, i) => [a.id, sims[i] - simMean])) as Record<ArchetypeId, number>,
    place: invite > 0.05 && placeSims[0][1] > 0.3 ? placeSims[0][0] : null,
    raw,
  };
}

function softmax(logits: Record<string, number>): Dist {
  const d = { ignore: 0, share: 0, go: 0, argue: 0 };
  const max = Math.max(...Object.values(logits));
  let total = 0;

  for (const a of ACTIONS)
    if (a in logits) {
      d[a] = Math.exp(logits[a] - max);
      total += d[a];
    }

  for (const a of ACTIONS) d[a] /= total;

  return d;
}

/** The hand-set formula. Weights were tuned so the four presets behave plausibly; see README. */
export function profileDist(f: Features, p: Profile, kind: MessageKind, place: PlaceId | null): Dist {
  const a = ARCHETYPES.find((x) => x.id === p.archetype) ?? ARCHETYPES[0];
  const trust = p.trusting ? 1 : 0.35;
  const interest = 6 * f.interest[p.archetype];
  const credible = 4 * f.credible;
  const told = p.source === "hub" ? 0.5 : p.source === "noticeboard" ? 0.2 : 0.3;

  if (kind === "counter") {
    // Believing a correction: easier if you doubted the rumour, harder if you'd bought it.
    const lean = p.believed ? -0.6 : 0.6;

    return softmax({
      ignore: 0.6 - a.chatty,
      share: 0.4 + lean + credible * trust + told + a.sceptic,
      argue: -0.6 - lean + (1 - a.sceptic) - credible,
    });
  }

  const believe = credible * trust + interest + told + 4 * f.warning * trust;

  return softmax({
    ignore: 0.9 - a.chatty + 0.4 * a.sceptic,
    share: believe + 1.2 * a.chatty - 0.6,
    ...(place ? { go: believe + 4 * f.invite + interest - 0.4 } : {}),
    argue: a.sceptic * (1.6 - credible) - 1.2,
  });
}
