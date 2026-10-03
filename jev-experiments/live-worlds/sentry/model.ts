/**
 * Screen sentry's free decider: a small logistic-regression classifier over one text
 * block of a web page, run in the browser or a Chrome extension with no network.
 *
 * Input: the block's text plus where it sits (hidden, tiny, off-screen, an HTML comment, alt
 * text, aria-hidden). Output: five probabilities, the same typed questions Jev is asked:
 *   addressed — is it addressed to an AI assistant rather than the human reader?
 *   goal      — does it ask the assistant to change what it was asked to do?
 *   secrets   — does it ask for or move private data (passwords, emails, cards)?
 *   instruction — is it an instruction rather than content (benign recipe steps count)?
 *   risk      — would following it hijack an assistant doing the user's task?
 *
 * Trained on blocks we wrote by hand from templates (dataset.ts) and on openly licensed prompt-
 * injection datasets (data/SOURCES.md), which train the risk head only. It never saw a Jev answer:
 * TypeSafe's Master Customer Agreement §2.3(b) forbids training a model to imitate Jev.
 */

export type Where = "visible" | "hidden" | "tiny" | "offscreen" | "comment" | "alt" | "aria-hidden";

export type Block = { text: string; where: Where };

export const HEADS = ["addressed", "goal", "secrets", "instruction", "risk"] as const;

export type Head = (typeof HEADS)[number];

export type Scores = Record<Head, number>;

export type Weights = { dim: number; heads: Record<Head, { w: number[]; b: number }> };

export const DIM = 2048;

const WHERE: Where[] = ["visible", "hidden", "tiny", "offscreen", "comment", "alt", "aria-hidden"];

/** Hand-picked cues, each one feature, so the model can weigh them directly. */
const CUES: [string, RegExp][] = [
  ["url", /\bhttps?:\/\/|\b[a-z0-9-]+\.(example|com|net|io|xyz)\b/i],
  ["email", /\b[\w.+-]+@[\w-]+\.\w+|\bemail\b/i],
  ["money", /[$£€]\s?\d/],
  ["you-ai", /\b(ai|assistant|agent|llm|language model|chatbot|bot)s?\b/i],
  ["override", /\b(ignore|disregard|forget|override)\b/i],
  ["system", /\b(system|developer|admin)\s*(prompt|note|notice|message|:)/i],
  ["secret", /\b(password|passcode|card number|cvv|api key|token|ssn|credentials?)\b/i],
  ["must", /\b(must|should|always|never|instead)\b/i],
  ["caps", /\b[A-Z]{4,}\b/],
  ["colon-start", /^\s*[A-Za-z ]{2,24}:/],
];

const tokens = (s: string) => s.toLowerCase().match(/[a-z0-9$£€@.]+/g) ?? [];

/** FNV-1a, so the browser and the trainer hash identically. */
function hash(s: string) {
  let h = 0x811c9dc5;

  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }

  return (h >>> 0) % DIM;
}

/** Sparse features: [index, value] pairs, L2-normalised text part plus fixed cue and layout slots. */
export function features(b: Block): [number, number][] {
  const t = tokens(b.text);
  const counts = new Map<number, number>();

  for (let i = 0; i < t.length; i++) {
    counts.set(hash("w:" + t[i]), (counts.get(hash("w:" + t[i])) ?? 0) + 1);

    if (i > 0) counts.set(hash("b:" + t[i - 1] + " " + t[i]), (counts.get(hash("b:" + t[i - 1] + " " + t[i])) ?? 0) + 1);
  }

  const norm = Math.sqrt([...counts.values()].reduce((a, c) => a + c * c, 0)) || 1;
  const out: [number, number][] = [...counts].map(([i, c]) => [i, c / norm]);

  for (const [name, re] of CUES) if (re.test(b.text)) out.push([hash("cue:" + name), 1]);

  out.push([hash("where:" + b.where), 1]);

  if (b.where !== "visible") out.push([hash("where:not-visible"), 1]);

  out.push([hash("len:" + Math.min(4, Math.floor(t.length / 8))), 0.5]);

  return out;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

export function score(w: Weights, b: Block): Scores {
  const x = features(b);
  const out = {} as Scores;

  for (const h of HEADS) {
    let z = w.heads[h].b;

    for (const [i, v] of x) z += w.heads[h].w[i] * v;

    out[h] = sigmoid(z);
  }

  return out;
}

export const RISK_THRESHOLD = 0.5;

export const WHERE_KINDS = WHERE;
