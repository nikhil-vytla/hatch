/**
 * Who said that? Step two: three typed questions about each line's words, asked of the free
 * in-browser rules or of Jev. None of them depends on how we've grouped anything so far, so a
 * recorded Jev answer stays valid whatever the visitor toggles.
 *
 * - continues (yes/no): does this line carry on the previous one?
 * - replyTo (choice): which of the last few lines does it answer or continue, or none?
 * - newTopic (yes/no): does it start a new topic compared with the lines before it?
 */
import type { Heard } from "./signals";

/** How many earlier lines a line may reply to. */
export const LOOKBACK = 6;

export type TextAnswers = {
  continues: number;
  /** Probability per earlier line, oldest first (length = min(LOOKBACK, i)), then `none`. */
  replyTo: number[];
  newTopic: number;
};

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

export const words = (t: string) => t.toLowerCase().match(/[a-z']+/g) ?? [];

const LEADS = new Set(["and", "or", "but", "so", "then", "because", "which", "that", "right"]);
const HANGING = new Set(["and", "or", "but", "the", "a", "an", "to", "of", "with", "for", "so", "is", "be", "we're", "we"]);
/** Phrases that tend to open a new topic in meetings. */
const SHIFTS = ["okay so", "ok so", "right so", "so next", "next", "moving on", "now let's", "let's move", "the next thing", "another thing", "what about", "anyway", "alright so", "all right so"];

export function cosine(a: number[], b: number[]) {
  let s = 0;

  for (let i = 0; i < a.length; i++) s += a[i] * b[i];

  return s;
}

/** Free answer: does this line continue the previous one? Word cues and timing. */
export function freeContinues(prev: Heard | undefined, cur: Heard): number {
  if (!prev) return 0.05;

  const a = words(prev.text);
  const b = words(cur.text);
  let x = -1.6;

  if (a.length && b.length && a.at(-1) === b[0]) x += 2.5;

  if (HANGING.has(a.at(-1) ?? "")) x += 1.6;

  if (LEADS.has(b[0] ?? "")) x += 0.8;

  if (!/[.?!]$/.test(prev.text.trim())) x += 0.6;

  if (cur.start - prev.end < 0.35) x += 0.7;

  return sigmoid(x);
}

/** Free answer: which earlier line does this one respond to? Meaning similarity, nearer lines first. */
export function freeReplyTo(earlier: Heard[], cur: Heard): number[] {
  const logits = earlier.map((h, k) => 8 * cosine(h.meaning, cur.meaning) - 0.3 * (earlier.length - 1 - k));
  const all = [...logits, 8 * 0.3];
  const m = Math.max(...all);
  const e = all.map((v) => Math.exp(v - m));
  const z = e.reduce((s, v) => s + v, 0);

  return e.map((v) => v / z);
}

/** Free answer: does this line start a new topic? Low similarity to the last few lines, or a shift phrase. */
export function freeNewTopic(earlier: Heard[], cur: Heard): number {
  if (!earlier.length) return 0.5;

  const recent = earlier.slice(-3);
  const best = Math.max(...recent.map((h) => cosine(h.meaning, cur.meaning)));
  const t = cur.text.toLowerCase();
  const shift = SHIFTS.some((s) => t.startsWith(s) || t.includes(` ${s} `));
  const long = words(cur.text).length >= 5;

  return sigmoid((0.25 - best) * 9 + (shift ? 1.5 : 0) + (long ? 0.3 : -1.2) - 0.8);
}

export function freeAnswers(heard: Heard[]): TextAnswers[] {
  return heard.map((cur, i) => {
    const earlier = heard.slice(Math.max(0, i - LOOKBACK), i);

    return { continues: freeContinues(heard[i - 1], cur), replyTo: freeReplyTo(earlier, cur), newTopic: freeNewTopic(earlier, cur) };
  });
}

/** Jev's typed request for line `i`: the last few lines as state, three questions. */
export function jevRequest(heard: Heard[], i: number) {
  const earlier = heard.slice(Math.max(0, i - LOOKBACK), i);
  const labels = earlier.map((_, k) => `L${k + 1}`);

  return {
    state: {
      setting: "A transcript of people talking in a room. Lines come from speech recognition and may contain mistakes. Several people, and possibly more than one conversation, may be present.",
      earlier: Object.fromEntries(earlier.map((h, k) => [labels[k], h.text])),
      line: heard[i].text,
    },
    questions: {
      continues: {
        type: "noul",
        instructions: earlier.length
          ? `Does "line" continue the last earlier line (${labels.at(-1)}): the same sentence or the same person's train of thought?`
          : `Does "line" continue an earlier line? There are none.`,
      },
      // The first line has nothing to reply to, and a choice needs at least two options.
      ...(earlier.length
        ? {
            replyTo: {
              type: "choice",
              instructions: `Which earlier line does "line" most directly respond to or continue? Choose none if it starts something unrelated to all of them.`,
              criteria: { ...Object.fromEntries(earlier.map((h, k) => [labels[k], h.text])), none: "None of the earlier lines" },
            },
          }
        : {}),
      newTopic: {
        type: "noul",
        instructions: `Does "line" start a new topic, compared with the earlier lines?`,
      },
    },
  };
}

type Answer = { value?: unknown; probabilities?: Record<string, number> | null };

/** Jev's answers to `jevRequest` as text answers. */
export function fromJev(answers: Record<string, Answer>, earlierCount: number): TextAnswers {
  const yes = (a: Answer | undefined) => (typeof a?.value === "number" ? a.value : 0.5);
  const p = answers.replyTo?.probabilities ?? {};
  const keys = [...Array.from({ length: earlierCount }, (_, k) => `L${k + 1}`), "none"];
  const raw = keys.map((k) => Number(p[k] ?? 0));
  const z = raw.reduce((s, v) => s + v, 0);

  return {
    continues: yes(answers.continues),
    replyTo: z > 0 ? raw.map((v) => v / z) : keys.map(() => 1 / keys.length),
    newTopic: yes(answers.newTopic),
  };
}

/** Whole-transcript count questions, asked once per scenario. */
export function jevCountRequest(heard: Heard[]) {
  return {
    state: {
      setting: "A transcript of people talking in a room, from speech recognition. It may mix more than one conversation.",
      lines: Object.fromEntries(heard.map((h, i) => [`L${i + 1}`, h.text])),
    },
    questions: {
      conversations: {
        type: "choice",
        instructions: "How many separate conversations are going on in these lines?",
        criteria: { one: "One conversation", two: "Two conversations", three: "Three or more conversations" },
      },
      topics: {
        type: "choice",
        instructions: "How many different topics do these lines cover, across all conversations?",
        criteria: { one: "One topic", two: "Two topics", three: "Three topics", four: "Four topics", five: "Five or more topics" },
      },
    },
  };
}
