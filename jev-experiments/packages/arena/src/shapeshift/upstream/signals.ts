import type {
  Answer,
  ColorMood,
  EventMode,
  ExpenseCategory,
  IntentResult,
  SignalKey,
  Signals,
  TimerKind,
  Tone,
  Transport,
  TripType,
} from "./jev/types";

export const SIGNAL_THRESHOLDS = {
  choiceMin: 0.6,
  /** Once shown, a choice value survives a small dip in confidence. */
  choiceKeep: 0.5,
  noulOn: 0.65,
  noulOff: 0.45,
  urgentOn: 1.2,
  urgentOff: 1.0,
} as const;

export type GatedSignals = {
  eventMode: EventMode | null;
  transport: Transport | null;
  tripType: TripType | null;
  expenseCategory: ExpenseCategory | null;
  colorMood: ColorMood | null;
  timerKind: TimerKind | null;
  tone: Tone | null;
  recurring: boolean;
  isQuestion: boolean;
  hasExplicitOptions: boolean;
  isShoppingList: boolean;
  /** Continuous 0..2, used for smooth mappings. */
  urgency: number;
  /** Past the caution threshold (with hysteresis). */
  urgent: boolean;
};

export const neutralGated: GatedSignals = {
  eventMode: null,
  transport: null,
  tripType: null,
  expenseCategory: null,
  colorMood: null,
  timerKind: null,
  tone: null,
  recurring: false,
  isQuestion: false,
  hasExplicitOptions: false,
  isShoppingList: false,
  urgency: 0,
  urgent: false,
};

const ESCAPES = new Set(["unspecified", "other"]);

function gateChoice<T extends string>(a: Answer<T>, prev: T | null): T | null {
  if (ESCAPES.has(a.value)) return null;
  if (a.confidence >= SIGNAL_THRESHOLDS.choiceMin) return a.value;
  if (prev === a.value && a.confidence >= SIGNAL_THRESHOLDS.choiceKeep) return prev;
  return null;
}

function gateNoul(p: number, prev: boolean): boolean {
  if (p >= SIGNAL_THRESHOLDS.noulOn) return true;
  if (p <= SIGNAL_THRESHOLDS.noulOff) return false;
  return prev;
}

type ChoiceKey = "eventMode" | "transport" | "tripType" | "expenseCategory" | "colorMood" | "timerKind" | "tone";
type NoulKey = "recurring" | "isQuestion" | "hasExplicitOptions" | "isShoppingList";
const CHOICE_KEYS: ChoiceKey[] = ["eventMode", "transport", "tripType", "expenseCategory", "colorMood", "timerKind", "tone"];
const NOUL_KEYS: NoulKey[] = ["recurring", "isQuestion", "hasExplicitOptions", "isShoppingList"];

/**
 * Read only the signals the committed intent uses, applying thresholds and
 * hysteresis so badges and icons don't blink while typing.
 */
export function gateSignals(prev: GatedSignals, result: IntentResult, used: readonly SignalKey[]): GatedSignals {
  const s: Signals = result.signals;
  const next: GatedSignals = { ...neutralGated };
  const uses = new Set(used);

  for (const k of CHOICE_KEYS) {
    if (!uses.has(k)) continue;
    // Each key maps to its own answer type; the cast keeps the loop generic.
    (next as Record<ChoiceKey, string | null>)[k] = gateChoice(s[k] as Answer<string>, prev[k]);
  }
  for (const k of NOUL_KEYS) {
    if (!uses.has(k)) continue;
    next[k] = gateNoul(s[k], prev[k]);
  }
  if (uses.has("urgency")) {
    next.urgency = s.urgency.score;
    next.urgent = prev.urgent ? s.urgency.score > SIGNAL_THRESHOLDS.urgentOff : s.urgency.score > SIGNAL_THRESHOLDS.urgentOn;
  }
  return next;
}
