/**
 * Code baselines for the Café Jev preference questions. They answer the same
 * typed questions Jev answered (one token per preference field, plus a source
 * turn and a drink family) so the café engine can interpret every contestant
 * the same way.
 */
import { FIELDS, VALUES, candidates, emptyPreferences, type Field, type PublicInput } from "../../../cafe-jev/engine";

export const tokensFor = (field: Field) => [...Object.keys(VALUES[field]).flatMap((v) => [`required_${v}`, `preferred_${v}`]), "unknown", "conflicting"];

type Answers = Record<string, { value: string; probabilities?: Record<string, number> }>;

const NUMBERS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const NEGATION = /\b(no|not|without|don't|dont|doesn't|never|zero|nothing)\b|-free\b|\bfree of\b/;
const SOFT = /\b(preferably|ideally|if possible|would be nice|i'd like|rather)\b/;
const DROP = /\b(don't care|doesn't matter|doesn't have to|no preference|either is fine)\b/;

/** Reads one clause and returns the field values it states. */
function clause(text: string): Partial<Record<Field, string>> {
  const t = text.toLowerCase(), neg = NEGATION.test(t), out: Partial<Record<Field, string>> = {};
  if (/\b(cold|iced|ice|chilled)\b/.test(t)) out.temperature = neg ? "hot" : "cold";
  if (/\b(hot|warm)\b/.test(t)) out.temperature = neg ? "cold" : "hot";
  if (/\b(50 ?mg|low caffeine|a little caffeine|half-caf)\b/.test(t)) out.caffeine = "low";
  else if (/\b(caffeine|caffeinated|decaf)\b/.test(t)) out.caffeine = neg || /decaf/.test(t) ? "no" : "yes";
  if (/\b(dairy|milk)\b/.test(t) && !/\b(oat|soy)\b/.test(t)) out.dairy = neg ? "no" : "yes";
  if (/\b(oat|soy)\b/.test(t)) out.dairy = "no";
  if (/\bunsweetened\b/.test(t)) out.sweet = "no";
  else if (/\b(sweet|sweetness|sugar|sweetened)\b/.test(t)) out.sweet = neg ? "no" : "yes";
  if (/\b(creamy|cream|creaminess)\b/.test(t)) out.creamy = neg ? "no" : "yes";
  if (/\bcoffee\b/.test(t)) out.coffee = neg ? "no" : "yes";
  const money = /\$(\d+(?:\.\d+)?)/.exec(t) ?? /\b(\d+|two|three|four|five|six|seven|eight|nine|ten) dollars?\b/.exec(t);
  if (money) {
    const amount = Number.isFinite(Number(money[1])) ? Number(money[1]) : NUMBERS[money[1]];
    const cents = Math.round(amount * 100);
    out.budget = [300, 400, 500, 600, 800].includes(cents) ? String(cents) : "unsupported";
  }
  return out;
}

/**
 * A hand-written keyword reader: later turns revise earlier ones, "don't care"
 * clears a field, two values for one field in one turn are a conflict, and
 * "preferably"/"ideally" make a preference soft. Every answer is one-hot.
 */
export function keywordAnswers(input: PublicInput): Answers {
  const state: Partial<Record<Field, { token: string; turn: number }>> = {};
  for (const turn of input.transcript.filter((t) => t.kind === "customer")) {
    const seen: Partial<Record<Field, string>> = {};
    for (const piece of turn.text.split(/[.;!?]|,|\band\b|\bbut\b|\bthough\b/i).map((s) => s.trim()).filter(Boolean)) {
      const lower = piece.toLowerCase();
      if (DROP.test(lower)) { for (const f of Object.keys(clause(lower)) as Field[]) delete state[f]; for (const f of FIELDS) if (lower.includes(f === "sweet" ? "sweet" : f)) delete state[f]; continue; }
      const strength = SOFT.test(lower) ? "preferred" : "required";
      for (const [f, v] of Object.entries(clause(lower)) as [Field, string][]) {
        const token = seen[f] && seen[f] !== v ? "conflicting" : `${strength}_${v}`;
        seen[f] = v;
        state[f] = { token, turn: turn.id };
      }
    }
  }
  return fromTokens(input, Object.fromEntries(FIELDS.map((f) => [f, state[f] ? { value: state[f]!.token, turn: state[f]!.turn } : { value: "unknown", turn: 0 }])) as any);
}

/** Answers with a fixed distribution per field (e.g. how often each token is correct across the cases). */
export function priorAnswers(input: PublicInput, prior: Record<Field, Record<string, number>>): Answers {
  const picks = Object.fromEntries(FIELDS.map((f) => {
    const [token] = Object.entries(prior[f]).sort((a, b) => b[1] - a[1])[0];
    const last = input.transcript.filter((t) => t.kind === "customer").at(-1)?.id ?? 1;
    return [f, { value: token, turn: last, probabilities: prior[f] }];
  }));
  return fromTokens(input, picks as any);
}

/** Adds source turns and lets code pick the best legal drink family for the extracted preferences. */
function fromTokens(input: PublicInput, picks: Record<Field, { value: string; turn: number; probabilities?: Record<string, number> }>): Answers {
  const answers: Answers = {};
  const prefs = emptyPreferences();
  for (const f of FIELDS) {
    const { value, turn, probabilities } = picks[f];
    answers[f] = { value, probabilities: probabilities ?? Object.fromEntries(tokensFor(f).map((t) => [t, t === value ? 1 : 0])) };
    answers[`${f}_source`] = { value: value === "unknown" ? "none" : String(turn) };
    const m = /^(required|preferred)_(.+)$/.exec(value);
    if (m) prefs[f] = { status: m[1] as "required" | "preferred", value: m[2], sourceTurn: turn, evidence: null };
    else if (value === "conflicting") prefs[f] = { status: "conflicting", value: null, sourceTurn: turn, evidence: null };
  }
  answers.family = { value: candidates(prefs, input.inventory)[0]?.family ?? "none" };
  answers.question = { value: "done" };
  return answers;
}
