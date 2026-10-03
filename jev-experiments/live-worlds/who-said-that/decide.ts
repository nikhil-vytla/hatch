/**
 * Who said that? Step three: the typed decisions, line by line, and the bookkeeping code keeps
 * from them.
 *
 * For each line, in order, three decisions:
 * - **speaker** (choice): one of the speakers so far, or someone new;
 * - **conversation** (choice): one of the conversations so far, or a new one;
 * - **new topic** (yes/no): within that conversation.
 *
 * Every option's score is a sum of named signal contributions (voice, level, continuation,
 * timing, topic, reply, the speaker's conversation, shift), so the page can show exactly what
 * pushed each judgement, and a visitor can switch a signal off. Code, not a model, keeps the
 * running speakers, conversations and topics: centroids, levels and counts.
 *
 * Weights are hand-set (see README for the development windows they were set on); nothing is
 * trained on Jev's answers.
 */
import { cosine, LOOKBACK, type TextAnswers } from "./questions";
import type { Heard } from "./signals";

export const SIGNALS = ["voice", "level", "continues", "timing", "topic", "reply", "membership", "shift"] as const;

export type Signal = (typeof SIGNALS)[number];

export type Weights = Record<Signal, number>;

export const ALL_ON: Weights = { voice: 1, level: 1, continues: 1, timing: 1, topic: 1, reply: 1, membership: 1, shift: 1 };

export const SIGNAL_LABELS: Record<Signal, string> = {
  voice: "Voice match",
  level: "Loudness or microphone",
  continues: "Continues the last line",
  timing: "Turn timing",
  topic: "Topic match",
  reply: "Replies to a line in it",
  membership: "Where this speaker talks",
  shift: "Topic shift",
};

/** One option of one decision: its probability and each signal's push on its score. */
export type Option = { id: number; label: string; p: number; push: Partial<Record<Signal, number>> };

export type Decision = { options: Option[]; chosen: number };

export type Line = {
  i: number;
  speaker: Decision;
  conversation: Decision;
  newTopic: { p: number; push: Partial<Record<Signal, number>>; yes: boolean };
  /** The ids code assigned after the decisions. */
  who: number;
  conv: number;
  topic: number;
};

type Speaker = { id: number; voice: number[]; db: number; n: number; seconds: number; convs: Map<number, number>; channels: Map<number, number> };

type Topic = { id: number; meaning: number[]; n: number; since: number };

type Conversation = { id: number; meaning: number[]; db: number; n: number; topics: Topic[]; channels: Map<number, number> };

/**
 * The level push. With one microphone: how far this line's loudness is from the group's (3 dB
 * costs one point). With one microphone per table: whether the group is mostly heard on this
 * line's microphone, counted more when the line is clearly louder there.
 */
function levelPush(h: Heard, g: { db: number; n: number; channels: Map<number, number> }, w: number) {
  if (h.channel === undefined) return (w * -Math.abs(h.db - g.db)) / 3;

  const share = g.n ? (g.channels.get(h.channel) ?? 0) / g.n : 0.5;
  const clear = Math.min(1, Math.max(0.3, (h.balance ?? 0) / 6));

  return w * (share - 0.5) * 8 * clear;
}

export type State = { speakers: Speaker[]; conversations: Conversation[]; topicIds: number; lines: Line[] };

const NEW = -1;

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

const unit = (v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;

  return v.map((x) => x / n);
};

/** Running mean for counts below `cap`, then an exponential average (recent speech matters more). */
function blend(old: number[], next: number[], n: number, cap: number) {
  const a = 1 / Math.min(n + 1, cap);

  return unit(old.map((x, k) => x * (1 - a) + next[k] * a));
}

function softmax(options: { id: number; label: string; push: Partial<Record<Signal, number>>; bias: number }[]): Option[] {
  const score = options.map((o) => o.bias + Object.values(o.push).reduce((s, v) => s + (v ?? 0), 0));
  const m = Math.max(...score);
  const e = score.map((s) => Math.exp(s - m));
  const z = e.reduce((s, v) => s + v, 0);

  return options.map((o, k) => ({ id: o.id, label: o.label, p: e[k] / z, push: o.push }));
}

/**
 * The level push for "a new conversation". One microphone: a small cost, since a new group is
 * rarely needed. One microphone per table: a line clearly on a microphone no conversation lives on
 * favours a new one, and a line on an occupied microphone counts against it.
 */
function newLevelPush(h: Heard, conversations: Conversation[], w: number) {
  if (h.channel === undefined) return w * -1.2;

  const lives = conversations.some((c) => c.n && (c.channels.get(h.channel!) ?? 0) / c.n > 0.5);
  const clear = Math.min(1, Math.max(0.3, (h.balance ?? 0) / 6));

  return w * (lives ? -2 : 4 * clear);
}

/** The speaker decision for line `i`. */
export function speakerOptions(s: State, heard: Heard[], text: TextAnswers[], i: number, w: Weights) {
  const h = heard[i];
  const prev = s.lines[i - 1];
  const gap = i ? h.start - heard[i - 1].end : 9;
  const cont = text[i].continues;

  const known = s.speakers.map((sp) => {
    const same = prev?.who === sp.id;

    return {
      id: sp.id,
      label: `Speaker ${sp.id + 1}`,
      bias: 0,
      push: {
        // 0.3 sits between same-speaker (median about 0.45, profiles higher) and different-speaker
        // (about 0.05) similarity on the development windows.
        voice: w.voice * (cosine(h.voice, sp.voice) - 0.3) * 10,
        level: levelPush(h, sp, w.level),
        continues: same ? w.continues * (cont - 0.4) * 4 : 0,
        timing: same && gap < 0.3 ? w.timing * 0.8 : 0,
      },
    };
  });

  // "Someone new" wins when no profile clears the voice cut-off (0.3, from the development windows).
  return softmax([...known, { id: NEW, label: "Someone new", bias: s.speakers.length ? 0 : 5, push: {} }]);
}

/** The conversation decision for line `i`, given who we decided is speaking. */
export function conversationOptions(s: State, heard: Heard[], text: TextAnswers[], i: number, who: number, w: Weights) {
  const h = heard[i];
  const speaker = s.speakers.find((sp) => sp.id === who);
  const earlier = s.lines.slice(Math.max(0, i - LOOKBACK), i);
  const reply = text[i].replyTo;
  const offset = reply.length - 1 - earlier.length;
  const total = speaker ? [...speaker.convs.values()].reduce((a, b) => a + b, 0) : 0;
  const cont = text[i].continues;
  const prev = s.lines[i - 1];

  const known = s.conversations.map((c) => {
    const replyMass = earlier.reduce((m, l, k) => (l.conv === c.id ? m + (reply[k + offset] ?? 0) : m), 0);
    const share = speaker && total ? (speaker.convs.get(c.id) ?? 0) / total : 0;

    return {
      id: c.id,
      label: `Conversation ${String.fromCharCode(65 + c.id)}`,
      bias: 0,
      push: {
        topic: w.topic * (cosine(h.meaning, c.meaning) - 0.18) * 7,
        reply: w.reply * (replyMass - 0.3) * 3,
        membership: speaker ? w.membership * (share - 0.5) * 3 : 0,
        level: levelPush(h, c, w.level),
        continues: prev?.conv === c.id ? w.continues * (cont - 0.4) * 2 : 0,
      },
    };
  });
  const none = reply.at(-1) ?? 0;

  return softmax([
    ...known,
    {
      id: NEW,
      label: "A new conversation",
      bias: s.conversations.length ? -2.2 : 5,
      push: { reply: s.conversations.length ? w.reply * (none - 0.5) * 3 : 0, level: s.conversations.length ? newLevelPush(h, s.conversations, w.level) : 0 },
    },
  ]);
}

/** P(this line starts a new topic) within its conversation. */
export function newTopicOdds(conv: Conversation | undefined, heard: Heard[], text: TextAnswers[], i: number, w: Weights) {
  const topic = conv?.topics.at(-1);

  if (!conv || !topic) return { p: 1, push: {} };

  const push = {
    shift: w.shift * (text[i].newTopic - 0.5) * 3,
    topic: w.topic * (0.2 - cosine(heard[i].meaning, topic.meaning)) * 6,
  };
  const settled = topic.n >= 5 ? 0 : -2;

  return { p: sigmoid(-1.4 + settled + push.shift + push.topic), push };
}

export const empty = (): State => ({ speakers: [], conversations: [], topicIds: 0, lines: [] });

type Pick = (options: Option[]) => number;

const argmax: Pick = (o) => o.reduce((b, x) => (x.p > b.p ? x : b)).id;

/** Decide line `i` and update the state. `pick` chooses among options (argmax, or sampling for counts). */
export function step(s: State, heard: Heard[], text: TextAnswers[], i: number, w: Weights, pick: Pick = argmax, coin = () => 0) {
  const h = heard[i];
  const spOpts = speakerOptions(s, heard, text, i, w);
  let who = pick(spOpts);

  if (who === NEW) {
    who = s.speakers.length;
    s.speakers.push({ id: who, voice: h.voice, db: h.db, n: 0, seconds: 0, convs: new Map(), channels: new Map() });
  }

  const sp = s.speakers[who];
  const cvOpts = conversationOptions(s, heard, text, i, who, w);
  let conv = pick(cvOpts);

  if (conv === NEW) {
    conv = s.conversations.length;
    s.conversations.push({ id: conv, meaning: h.meaning, db: h.db, n: 0, topics: [], channels: new Map() });
  }

  const c = s.conversations[conv];
  const nt = newTopicOdds(c, heard, text, i, w);
  const yes = coin() ? coin() < nt.p : nt.p > 0.5;

  if (yes || !c.topics.length) c.topics.push({ id: s.topicIds++, meaning: h.meaning, n: 0, since: i });

  const topic = c.topics.at(-1)!;

  sp.voice = blend(sp.voice, h.voice, sp.n, 8);
  sp.db = sp.n ? sp.db + (h.db - sp.db) / Math.min(sp.n + 1, 8) : h.db;
  sp.n++;
  sp.seconds += h.end - h.start;
  sp.convs.set(conv, (sp.convs.get(conv) ?? 0) + 1);

  if (h.channel !== undefined) {
    sp.channels.set(h.channel, (sp.channels.get(h.channel) ?? 0) + 1);
    c.channels.set(h.channel, (c.channels.get(h.channel) ?? 0) + 1);
  }
  c.meaning = blend(c.meaning, h.meaning, c.n, 5);
  c.db = c.n ? c.db + (h.db - c.db) / Math.min(c.n + 1, 8) : h.db;
  c.n++;
  topic.meaning = blend(topic.meaning, h.meaning, topic.n, 4);
  topic.n++;

  const line: Line = {
    i,
    speaker: { options: spOpts, chosen: who },
    conversation: { options: cvOpts, chosen: conv },
    newTopic: { ...nt, yes: yes || topic.since === i },
    who,
    conv,
    topic: topic.id,
  };

  s.lines.push(line);

  return line;
}

/** All lines up to `until` (exclusive), deciding by argmax. */
export function decide(heard: Heard[], text: TextAnswers[], w: Weights = ALL_ON, until = heard.length): State {
  const s = empty();

  for (let i = 0; i < until; i++) step(s, heard, text, i, w);

  return s;
}

/** Counts that code keeps from a state: speakers with 2+ lines, conversations with 3+, topics with 2+. */
export function counts(s: State) {
  return {
    speakers: s.speakers.filter((sp) => sp.n >= 2).length,
    conversations: s.conversations.filter((c) => c.n >= 3).length,
    topics: s.conversations.reduce((n, c) => n + c.topics.filter((t) => t.n >= 2).length, 0),
  };
}

/** A small seeded generator, so sampled counts are repeatable. */
export function rng(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;

    let t = a;

    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type CountOdds = Record<"speakers" | "conversations" | "topics", Map<number, number>>;

/**
 * How sure are the counts? Re-run the same decisions `samples` times, choosing each option with
 * its probability instead of always the most likely, and tally what the counts come out as.
 */
export function countOdds(heard: Heard[], text: TextAnswers[], w: Weights, until: number, samples = 60, seed = 7): CountOdds {
  const r = rng(seed);
  const tally: CountOdds = { speakers: new Map(), conversations: new Map(), topics: new Map() };
  const sample: Pick = (o) => {
    let x = r();

    for (const opt of o) {
      x -= opt.p;

      if (x <= 0) return opt.id;
    }

    return o.at(-1)!.id;
  };

  for (let k = 0; k < samples; k++) {
    const s = empty();

    for (let i = 0; i < until; i++) step(s, heard, text, i, w, sample, () => r() || 1e-9);

    const c = counts(s);

    for (const key of ["speakers", "conversations", "topics"] as const) tally[key].set(c[key], (tally[key].get(c[key]) ?? 0) + 1 / samples);
  }

  return tally;
}

/**
 * With hindsight: once more lines have arrived, reassign each earlier line to the speaker and
 * conversation it fits best now (voice and level for speakers; topic, level and the speaker's
 * conversation for conversations). Lines can change label as evidence builds up.
 */
export function hindsight(s: State, heard: Heard[], w: Weights): { who: number; conv: number }[] {
  const real = s.speakers.filter((sp) => sp.n >= 2);
  const convs = s.conversations.filter((c) => c.n >= 3);

  return s.lines.map((l) => {
    const h = heard[l.i];
    const best = <T,>(xs: T[], f: (x: T) => number, fallback: number, id: (x: T) => number) => {
      let out = fallback;
      let top = -Infinity;

      for (const x of xs) {
        const v = f(x);

        if (v > top) {
          top = v;
          out = id(x);
        }
      }

      return out;
    };
    const who = best(real, (sp) => w.voice * cosine(h.voice, sp.voice) * 10 + levelPush(h, sp, w.level), l.who, (sp) => sp.id);
    const speaker = s.speakers[who];
    const total = speaker ? [...speaker.convs.values()].reduce((a, b) => a + b, 0) : 0;
    const conv = best(
      convs,
      (c) =>
        w.topic * cosine(h.meaning, c.meaning) * 7 +
        levelPush(h, c, w.level) +
        (speaker && total ? w.membership * ((speaker.convs.get(c.id) ?? 0) / total) * 3 : 0),
      l.conv,
      (c) => c.id,
    );

    return { who, conv };
  });
}
