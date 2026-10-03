/**
 * PROTOTYPE — Who said that? The decision side. Each speech segment gets four typed questions:
 *
 *   sounds like whom?          choice  me / friend / someone else   (voice fingerprint)
 *   same topic as our chat?    yes/no                               (text similarity)
 *   continues the last line?   yes/no                               (word overlap, gap, punctuation)
 *   part of our conversation?  yes/no                               (combines the three)
 *
 * The answers are hand-set rules, not a trained model, and use no Jev output. (TypeSafe's
 * terms forbid training on Jev's answers; Jev may answer the two text questions live on the
 * visitor's own key instead.)
 */
import { cosine } from "./voice.proto";

export type Who = "me" | "friend" | "else";

export type Heard = {
  start: number;
  end: number;
  text: string;
  /** Standardised voice fingerprint. */
  voice: number[];
  /** Normalised sentence embedding of `text`, or null when no text model ran. */
  meaning: number[] | null;
};

export type Answers = {
  voice: Record<Who, number>;
  topic: number;
  continues: number;
  conversation: number;
  who: Who;
  reasons: string[];
};

export type Tags = {
  me: number[];
  friend: number[];
  /** Similarity a voice must beat to count as a tagged person: 0.25 for the MFCC fingerprint, 0.35 for CAM++. */
  bar?: number;
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** How sure the voice side is: similarity to each tagged voice, with "someone else" as the bar to beat. */
export function voiceOdds(voice: number[], tags: Tags, bar = 0.25, sharpness = 6): Record<Who, number> {
  const s = { me: cosine(voice, tags.me), friend: cosine(voice, tags.friend), else: bar };
  const e = { me: Math.exp(s.me * sharpness), friend: Math.exp(s.friend * sharpness), else: Math.exp(s.else * sharpness) };
  const z = e.me + e.friend + e.else;

  return { me: e.me / z, friend: e.friend / z, else: e.else / z };
}

const words = (t: string) => t.toLowerCase().match(/[a-z']+/g) ?? [];

const LEADS = new Set(["and", "or", "but", "so", "then", "because", "which", "that", "right"]);
const HANGING = new Set(["and", "or", "but", "the", "a", "to", "of", "facing", "with", "for", "so"]);

/**
 * Does this line carry on from the previous one? Strong cues: it repeats the previous line's
 * last word ("…facing" / "facing the garden"), the previous line hangs on a joining word
 * ("…and"), it opens with one ("and push…"), or it starts within a breath of the last.
 */
export function continuation(prev: Heard | null, cur: Heard): { p: number; why: string[] } {
  if (!prev) return { p: 0.05, why: ["first line"] };

  const a = words(prev.text);
  const b = words(cur.text);
  const why: string[] = [];
  const lastWord = a.at(-1) ?? "";
  const firstWord = b[0] ?? "";
  let x = -2;

  if (lastWord && lastWord === firstWord) {
    x += 3;
    why.push(`repeats "${firstWord}"`);
  }

  if (HANGING.has(lastWord)) {
    x += 1.8;
    why.push(`last line hangs on "${lastWord}"`);
  }

  if (LEADS.has(firstWord)) {
    x += 1.2;
    why.push(`opens with "${firstWord}"`);
  }

  const gap = cur.start - prev.end;

  if (gap < 0.3) {
    x += 0.8;
    why.push(`${Math.round(gap * 1000)} ms after`);
  }

  return { p: sigmoid(x), why };
}

/** Is this about what we're talking about? Best match to the last few lines of our conversation. */
export function topicOdds(cur: Heard, ours: Heard[]): { p: number; sim: number } {
  const ctx = ours.filter((h) => h.meaning).slice(-4);

  if (!cur.meaning || !ctx.length) return { p: 0.5, sim: 0 };

  const sim = Math.max(...ctx.map((h) => cosine(cur.meaning as number[], h.meaning as number[])));

  return { p: sigmoid((sim - 0.22) * 12), sim };
}

/**
 * The fourth question and the final label, from the first three answers and who spoke last.
 * A line that continues the last one, from an unclear voice, is more likely the other person
 * taking the turn (people finish each other's sentences).
 */
export function combine(voice: Record<Who, number>, topic: number, continues: number, lastWho: Who | null) {
  const known = voice.me + voice.friend;
  const conversation = sigmoid(3.2 * (known - 0.5) + 2.4 * (topic - 0.5) + 1.6 * (continues - 0.5));
  let { me, friend } = voice;
  const reasons: string[] = [];

  if (continues > 0.5 && lastWho && lastWho !== "else" && Math.abs(me - friend) < 0.25) {
    if (lastWho === "me") friend += 0.15;
    else me += 0.15;

    reasons.push("finishes the other person's sentence");
  }

  let who: Who = conversation < 0.5 ? "else" : me >= friend ? "me" : "friend";

  if (who === "else" && Math.max(me, friend) > 0.7) who = me >= friend ? "me" : "friend";

  reasons.unshift(`voice ${who === "else" ? "unfamiliar" : `like ${who}`} (${Math.round(Math.max(me, friend) * 100)}%)`);

  return { who, conversation, reasons };
}

/**
 * Redo the decisions with new answers to the text questions (e.g. from Jev), keeping each
 * segment's voice odds. Works on recorded results, which don't carry the voice vectors.
 */
export function redecide(answers: Answers[], text: { topic?: number; continues?: number }[]): Answers[] {
  let lastWho: Who | null = null;

  return answers.map((a, i) => {
    const topic = text[i]?.topic ?? a.topic;
    const continues = text[i]?.continues ?? a.continues;
    const c = combine(a.voice, topic, continues, lastWho);

    lastWho = c.who;

    return { ...a, topic, continues, ...c, reasons: [...c.reasons, `topic ${Math.round(topic * 100)}% (Jev)`, `continues ${Math.round(continues * 100)}% (Jev)`] };
  });
}

/**
 * All four answers for every segment, in order. Lines we decide are ours become the context for
 * the topic question that follows; a continuation prefers whoever didn't just speak.
 */
export function decideAll(heard: Heard[], tags: Tags, live?: (i: number) => { topic?: number; continues?: number } | undefined): Answers[] {
  const out: Answers[] = [];
  const ours: Heard[] = [];
  let last: { h: Heard; who: Who } | null = null;

  for (const [i, h] of heard.entries()) {
    const voice = voiceOdds(h.voice, tags, tags.bar);
    const t = topicOdds(h, ours);
    const c = continuation(last?.h ?? null, h);
    const override = live?.(i);
    const topic = override?.topic ?? t.p;
    const continues = override?.continues ?? c.p;
    const { who, conversation, reasons } = combine(voice, topic, continues, last?.who ?? null);

    reasons.push(`topic ${Math.round(topic * 100)}%${override?.topic !== undefined ? " (Jev)" : ""}`);

    if (c.why.length) reasons.push(`continues: ${c.why.join(", ")}`);

    out.push({ voice, topic, continues, conversation, who, reasons });

    if (who !== "else") ours.push(h);

    last = { h, who };
  }

  return out;
}
