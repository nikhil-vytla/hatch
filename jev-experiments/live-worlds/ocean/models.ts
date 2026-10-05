/**
 * How the reef asks a model what a fish should do. Every model gets the same options for a fish
 * (code filters out impossible ones, like hiding with no healthy coral near), and the same
 * sentences for its view (`viewText`) and options (`OPTION_TEXT`), but not the same request:
 *
 * - Jev: one request per batch of fish (`jevRequest`): a line about the reef, every batched
 *   fish's view under `Fish`, and one typed choice question per fish whose criteria are its
 *   options.
 * - MobileBERT (`decideWithNli`): one fish at a time; that fish's view alone is the premise and
 *   each option sentence a hypothesis. It doesn't read the Jev request: no reef line, no other
 *   fish, no question text. (packages/arena's `answerWithNli` can answer a Jev request directly,
 *   but the held-out table and the page measured MobileBERT this way, so it stays this way.)
 * - The hand-written rule and the evolved policy (rule.ts, policy.ts) read the `View` itself, no
 *   text: the rule its fields, the policy 17 numbers made from them.
 */
import type { ZeroShot } from "../../packages/arena/src/decide/nli";
import type { Action, Decision, View } from "./engine";

export const BROWSER_MODEL = "MobileBERT";
export const JEV_MODEL = "Jev";
/** Fish per Jev request. */
export const JEV_BATCH = 40;
/**
 * A live Jev run sends at most one batch every this many ticks (0.3 s, the recorded run's median
 * gap between batches), however fast the answers come: at most 200 requests a minute.
 */
export const JEV_EVERY = 9;
/**
 * The page's hard cap on one live Jev run on the visitor's key: a whole race at that pace fits
 * (200 requests, about $0.05 at the recorded run's ~6,500 input tokens a batch), and a run that
 * goes on past it stops asking until the visitor starts a new one.
 */
export const LIVE_CAP = { requests: 200, usd: 0.06 };

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
