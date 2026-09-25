/**
 * Replays one phrase as timed keystrokes through a classifier and the calm rules (calm.ts),
 * and measures what the visitor would have seen. Answers come from a lookup (recorded, or a
 * local classifier), so a recording made once can be replayed under any request policy.
 */
import { calm, cardOf, START, type Calm, type Shown } from "./calm";
import { keyword } from "./keyword";
import type { Reading } from "./questions";

/** Frozen before any recording: a steady typist who pauses briefly between words. */
export const TYPING = { msPerKey: 160, wordPauseMs: 240, debounceMs: 120, settleMs: 4000 } as const;

/**
 * cancel: upstream's policy; each keystroke aborts the request in flight.
 * latest: one request in flight; when it lands, ask for the newest text if it changed.
 */
export type Policy = "cancel" | "latest";

export type Answered = { reading: Reading; latencyMs: number };

/** undefined: the request failed or was not recorded; the UI keeps what it has. */
export type AnswerFor = (key: string) => Answered | undefined;

export type Keystroke = { at: number; text: string };

/** Upstream's cache key (src/lib/lru.ts): answers are shared by texts that normalize alike. */
export const normalizeKey = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export function keystrokes(phrase: string): Keystroke[] {
  const out: Keystroke[] = [];
  let at = 0;

  for (let i = 1; i <= phrase.length; i++) {
    if (i > 1) at += TYPING.msPerKey + (phrase[i - 2] === " " ? TYPING.wordPauseMs : 0);
    out.push({ at, text: phrase.slice(0, i) });
  }

  return out;
}

export type Frame = { at: number; shown: Shown; text: string };

export type Replay = {
  frames: Frame[];
  requests: number;
  landed: number;
  failed: number;
  lastKeyAt: number;
};

const label = (s: Shown) =>
  s.kind === "choose" ? `choose:${s.options.join("|")}` : `${s.kind}:${cardOf(s) ?? ""}`;

/** What upstream's box holds for text under two characters: nothing to ask about. */
const BLANK = keyword("");

export function replay(phrase: string, answerFor: AnswerFor, policy: Policy): Replay {
  const keys = keystrokes(phrase);
  const lastKeyAt = keys.at(-1)?.at ?? 0;
  const frames: Frame[] = [{ at: 0, shown: START.shown, text: "" }];
  let state: Calm = START;

  let requests = 0,
    landed = 0,
    failed = 0;

  const apply = (at: number, reading: Reading, text: string) => {
    state = calm(state, reading, text);

    if (label(state.shown) !== label(frames[frames.length - 1].shown))
      frames.push({ at, shown: state.shown, text });
  };

  /** Asks for `text` at `at`; returns when the answer lands (or undefined if it failed). */
  const ask = (at: number, text: string) => {
    requests++;
    const answer = answerFor(normalizeKey(text));

    if (!answer) {
      failed++;

      return undefined;
    }

    return { arrives: at + answer.latencyMs, reading: answer.reading, text };
  };

  // What each keystroke wants: a reset below two characters, or a request once the debounce passes.
  const wants = keys.flatMap((k, i) => {
    const next = keys[i + 1]?.at ?? Infinity;

    if (normalizeKey(k.text).length < 2) return [{ at: k.at, text: k.text, reset: true, next }];
    const at = k.at + TYPING.debounceMs;

    // The next keystroke clears the debounce timer before it fires.
    return at < next ? [{ at, text: k.text, reset: false, next }] : [];
  });

  if (policy === "cancel") {
    for (const w of wants) {
      if (w.reset) {
        apply(w.at, BLANK, w.text);
        continue;
      }

      const flight = ask(w.at, w.text);

      // The next keystroke aborts a request still in flight.
      if (flight && flight.arrives < w.next) {
        landed++;
        apply(flight.arrives, flight.reading, w.text);
      }
    }
  } else {
    type Flight = NonNullable<ReturnType<typeof ask>> & { stale: boolean };

    let i = 0;
    let inFlight: Flight | null = null;
    let queued: string | null = null;

    const send = (at: number, text: string): Flight | null => {
      const flight = ask(at, text);

      return flight ? { ...flight, stale: false } : null;
    };

    while (i < wants.length || inFlight) {
      const flight: Flight | null = inFlight;

      if (flight && flight.arrives <= (wants[i]?.at ?? Infinity)) {
        inFlight = null;
        landed++;

        if (!flight.stale) apply(flight.arrives, flight.reading, flight.text);

        if (queued !== null && normalizeKey(queued) !== normalizeKey(flight.text))
          inFlight = send(flight.arrives, queued);

        queued = null;
        continue;
      }

      const w = wants[i++];

      if (w.reset) {
        if (flight) flight.stale = true;
        queued = null;
        apply(w.at, BLANK, w.text);
      } else if (flight) queued = w.text;
      else inFlight = send(w.at, w.text);
    }
  }

  return { frames, requests, landed, failed, lastKeyAt };
}

export type Expected = { intent: string; acceptable?: string[] };

export type Outcome = {
  finalRight: boolean;
  committedAtEnd: boolean;
  wrongCommits: number;
  changes: number;
  /** ms from the first keystroke until the right card is committed for good; undefined if never. */
  timeToRight: number | undefined;
  requests: number;
  landed: number;
  failed: number;
};

export function outcome(r: Replay, expected: Expected): Outcome {
  const ok = new Set([expected.intent, ...(expected.acceptable ?? [])]);
  const settled = r.frames.filter((f) => f.at <= r.lastKeyAt + TYPING.settleMs);
  const last = settled[settled.length - 1].shown;
  const right = (s: Shown) => s.kind === "committed" && ok.has(s.intent);

  let timeToRight: number | undefined;

  for (let i = settled.length - 1; i >= 0 && right(settled[i].shown); i--)
    timeToRight = settled[i].at;

  return {
    finalRight: ok.has(cardOf(last) ?? ""),
    committedAtEnd: last.kind === "committed",
    wrongCommits: settled.filter((f) => f.shown.kind === "committed" && !ok.has(f.shown.intent))
      .length,
    changes: settled.length - 1,
    timeToRight,
    requests: r.requests,
    landed: r.landed,
    failed: r.failed,
  };
}
