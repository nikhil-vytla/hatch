/**
 * How the reef asks a model what a fish should do. Both models get the same view and the same
 * options (code filters out impossible ones, like hiding with no healthy coral near):
 *
 * - Jev: one typed choice question per fish, many fish per request.
 * - MobileBERT (in the browser): the view is the premise, each option a hypothesis.
 */
import type { ZeroShot } from "../../packages/arena/src/decide/nli";
import type { Action, Decision, View } from "./engine";

export const BROWSER_MODEL = "MobileBERT";
export const JEV_MODEL = "Jev";
/** Fish per Jev request. */
export const JEV_BATCH = 40;
// TypeSafe's list price: $0.042 per million input tokens, output free.
export const USD_PER_TOKEN = 0.042 / 1e6;

export const OPTION_TEXT: Record<Action, string> = {
  school: "Swim with the other fish in the school.",
  forage: "Go and eat the food nearby.",
  hide: "Hide inside the healthy coral.",
  flee: "Swim away fast from the danger.",
  follow: "Follow the fish that is calling about food.",
  signal: "Warn the other fish about the predator.",
  rest: "Rest and save energy.",
};

/** The view in plain sentences, avoiding negations a small model misreads. */
export function viewText(v: View) {
  const parts = [`My energy is ${v.energy}.`];

  if (v.predator) parts.push(`A shark is ${v.predator.distance}, ${v.predator.side === "above" || v.predator.side === "below" ? v.predator.side + " me" : "to my " + v.predator.side}.`);
  else parts.push("The water around me is calm and safe.");

  if (v.food) parts.push(v.food > 4 ? "There is plenty of food near me." : "There is a little food near me.");

  if (v.coral) parts.push(v.coral === "healthy" ? "Healthy coral is close by." : "The coral nearby is bleached and gives no cover.");

  parts.push(v.neighbours ? `${v.neighbours} other fish are near me.` : "I am alone.");

  if (v.signal) parts.push(v.signal === "danger" ? "A fish nearby is warning about danger." : "A fish nearby is calling about food.");

  for (const note of v.water) parts.push(`${note[0].toUpperCase()}${note.slice(1)}.`);

  return parts.join(" ");
}

/** The Jev request for a batch of fish: each fish's view in the state, one choice per fish. */
export function jevRequest(views: View[]) {
  return {
    state: {
      Reef: "A coral reef. Each small fish chooses its next action from what it can see. Survival needs food; sharks eat fish that are not hidden in healthy coral.",
      Fish: Object.fromEntries(views.map((v) => [`fish_${v.id}`, viewText(v)])),
    },
    questions: Object.fromEntries(
      views.map((v) => [
        `fish_${v.id}`,
        {
          type: "choice" as const,
          instructions: `What should fish_${v.id} do next, given what it can see (Fish.fish_${v.id})?`,
          criteria: Object.fromEntries(v.options.map((o) => [o, OPTION_TEXT[o]])),
        },
      ]),
    ),
  };
}

type WireAnswer = { value?: unknown; probabilities?: unknown };

const isAction = (v: unknown, options: Action[]): v is Action => options.some((o) => o === v);

function toProbabilities(p: unknown, options: Action[]) {
  if (!p || typeof p !== "object") return null;

  const out: Partial<Record<Action, number>> = {};

  for (const [k, v] of Object.entries(p)) if (isAction(k, options) && Number.isFinite(v)) out[k] = Number(v);

  return out;
}

/** Jev's answers as decisions; an answer outside the fish's options is dropped. */
export function fromJev(views: View[], answers: Record<string, WireAnswer>, latencyMs: number | null): Decision[] {
  return views.flatMap((v) => {
    const a = answers[`fish_${v.id}`];

    if (!a || !isAction(a.value, v.options)) return [];

    return [{ id: v.id, action: a.value, probabilities: toProbabilities(a.probabilities, v.options), by: JEV_MODEL, latencyMs }];
  });
}

/** One fish decided by the small zero-shot model. */
export async function decideWithNli(clf: ZeroShot, v: View): Promise<Decision> {
  const started = performance.now();
  const texts = v.options.map((o) => OPTION_TEXT[o]);
  const r = await clf(viewText(v), texts, { hypothesis_template: "{}" });
  const probabilities: Partial<Record<Action, number>> = {};

  for (const o of v.options) probabilities[o] = r.scores[r.labels.indexOf(OPTION_TEXT[o])] ?? 0;

  const action = v.options.reduce((best, o) => ((probabilities[o] ?? 0) > (probabilities[best] ?? 0) ? o : best), v.options[0]);

  return { id: v.id, action, probabilities, by: BROWSER_MODEL, latencyMs: Math.round(performance.now() - started) };
}
