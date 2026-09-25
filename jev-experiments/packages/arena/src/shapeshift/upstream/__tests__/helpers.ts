import { INTENT_KEYS, type IntentKey, type IntentResult, noneResult } from "../jev/types";

/** Build a result whose intent distribution is given explicitly; the rest share leftovers. */
export function result(probs: Partial<Record<IntentKey, number>>, signals: Partial<IntentResult["signals"]> = {}): IntentResult {
  const given = Object.values(probs).reduce((a, b) => a + (b ?? 0), 0);
  const others = INTENT_KEYS.filter((k) => !(k in probs));
  const leftover = Math.max(0, 1 - given) / others.length;
  const probabilities = Object.fromEntries(INTENT_KEYS.map((k) => [k, probs[k] ?? leftover])) as Record<IntentKey, number>;
  const top = INTENT_KEYS.reduce((a, b) => (probabilities[b] > probabilities[a] ? b : a));
  const base = noneResult();
  return {
    ...base,
    intent: { value: top, confidence: probabilities[top], probabilities },
    signals: { ...base.signals, ...signals },
  };
}
