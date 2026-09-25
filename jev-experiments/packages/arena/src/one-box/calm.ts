/**
 * Turns a flickery stream of readings into what the box shows. Shapeshift's calm-UI rules
 * (MIT, see NOTICE.md), restated as one reducer; a test replays upstream's own behaviour on
 * every prefix of 429 phrases and requires the same states. Upstream's chips and palette can
 * force a card; nobody forces one in a replay, so that path is left out.
 */
import { entriesOf, type CardIntent, type Intent, type Reading } from "./questions";

export type Shown =
  | { kind: "input" }
  | { kind: "ghost"; intent: CardIntent }
  | { kind: "choose"; options: [CardIntent, CardIntent] }
  | { kind: "committed"; intent: CardIntent };

export const THRESHOLDS = {
  /** Below this, keep waiting. */
  inputBelow: 0.4,
  /** At or above this, commit; in between, a faint preview. */
  commitAt: 0.7,
  /** Two options closer than this, both above the floor, are offered as chips. */
  chooseGap: 0.15,
  chooseFloor: 0.25,
  /** A challenger this sure replaces a committed card at once… */
  challengerOverride: 0.85,
  /** …otherwise it must win this many readings in a row. */
  challengerWins: 2,
  /** A committed card whose own probability falls below this is dropped. */
  dropBelow: 0.3,
} as const;

export type Calm = {
  shown: Shown;
  /** A different intent currently beating the committed one, and how many times in a row. */
  challenger: { intent: CardIntent; wins: number } | null;
};

export const START: Calm = { shown: { kind: "input" }, challenger: null };

const card = (intent: Intent): intent is CardIntent => intent !== "none";

/** Options by probability, highest first; ties keep question order. */
function ranked(r: Reading) {
  return entriesOf(r.intent.probabilities)
    .flatMap(([intent, p]) => (card(intent) && p !== undefined ? [{ intent, p }] : []))
    .sort((a, b) => b.p - a.p);
}

/** Two close, plausible cards: offer both. */
function closeCall(r: Reading): Shown | null {
  const [a, b] = ranked(r);

  return a &&
    b &&
    a.p > THRESHOLDS.chooseFloor &&
    b.p > THRESHOLDS.chooseFloor &&
    a.p - b.p < THRESHOLDS.chooseGap
    ? { kind: "choose", options: [a.intent, b.intent] }
    : null;
}

/** What one reading alone would show. */
export function shownFor(r: Reading): Shown {
  const { value: top, confidence } = r.intent;
  const top2 = entriesOf(r.intent.probabilities).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));

  if (!card(top) || confidence < THRESHOLDS.inputBelow)
    // A near-tie is worth offering even when neither side is confident, but not when "none" leads.
    return (card(top) && closeCall(r)) || { kind: "input" };

  // Upstream only offers chips when neither of the top two is "none".
  const noNone = top2.slice(0, 2).every(([k]) => card(k));

  if (noNone) {
    const close = closeCall(r);

    if (close) return close;
  }

  return confidence < THRESHOLDS.commitAt
    ? { kind: "ghost", intent: top }
    : { kind: "committed", intent: top };
}

/** The next state after a reading. Blank text resets. */
export function calm(prev: Calm, r: Reading, text: string): Calm {
  if (!text.trim()) return START;
  const fresh: Calm = { shown: shownFor(r), challenger: null };

  if (prev.shown.kind !== "committed") return fresh;

  // A committed card stays unless something clearly better keeps winning.
  const current = prev.shown.intent;
  const { value: top, confidence } = r.intent;
  const currentP = r.intent.probabilities[current] ?? 0;

  if (top === current) return { shown: prev.shown, challenger: null };

  if (!card(top))
    return currentP < THRESHOLDS.dropBelow ? START : { shown: prev.shown, challenger: null };

  if (confidence >= THRESHOLDS.challengerOverride)
    return { shown: { kind: "committed", intent: top }, challenger: null };

  const wins = prev.challenger?.intent === top ? prev.challenger.wins + 1 : 1;

  if (wins >= THRESHOLDS.challengerWins && confidence >= THRESHOLDS.inputBelow) return fresh;

  if (currentP < THRESHOLDS.dropBelow && confidence < THRESHOLDS.inputBelow) return START;

  return { shown: prev.shown, challenger: { intent: top, wins } };
}

/** The card the box is showing or previewing, if any. */
export const cardOf = (s: Shown) =>
  s.kind === "committed" || s.kind === "ghost" ? s.intent : null;
