/**
 * The square's in-browser decision model: a small zero-shot classifier (MobileBERT-MNLI, the
 * same one Decide runs) answering Jev's two questions per resident, in two easier steps:
 *
 * 1. Which open place is the notice about? (one classification of the notice alone)
 * 2. For each resident: would they want to go? (one yes/no against their story and tastes)
 *
 * A resident who would go heads to the notice's place; everyone else keeps their plan. Code
 * still validates and moves residents, so a weak answer is a bad choice, never an illegal one.
 *
 * The two-step framing and the 0.7 threshold were picked by comparing three framings with Jev's
 * recorded answers on the seven probe notices (see README), so that comparison flatters it.
 */
import type { ZeroShot } from "../../packages/arena/src/decide/nli";
import type { Reply } from "./engine";

export type CrowdInput = {
  notice: string;
  places: { id: string; name: string; open: boolean }[];
  residents: { id: string; name: string; story: string; preferences: string[] }[];
};

export const BROWSER_MODEL_NAME = "MobileBERT";

/** At or above this, a resident goes to the notice's place. */
export const WANTS = 0.7;

/** Below this, the notice reads as not for them. */
const NOT_FOR_ME = 0.35;

const aboutPlace = (name: string) => `This is about the ${name}.`;

export const residentPremise = (notice: string, r: CrowdInput["residents"][number]) =>
  `${r.name}: ${r.story} ${r.name} likes ${r.preferences.join(", ")}. Notice: ${notice}`;

/** Answers in Jev's wire shape; `onResident` reports progress after each resident. */
export async function answerCrowd(
  clf: ZeroShot,
  input: CrowdInput,
  onResident?: (done: number, total: number) => void,
): Promise<{ answers: Reply; place: string | null }> {
  const answers: Reply = {};
  const open = input.places.filter((p) => p.open);

  if (!open.length) return { answers, place: null };

  const where = await clf(
    input.notice,
    open.map((p) => aboutPlace(p.name)),
    { hypothesis_template: "{}" },
  );
  // The pipeline sorts labels by score, but don't rely on it.
  const top = where.labels[where.scores.indexOf(Math.max(...where.scores))];
  const place = open.find((p) => aboutPlace(p.name) === top) ?? open[0];

  for (const [i, r] of input.residents.entries()) {
    const out = await clf(residentPremise(input.notice, r), [`${r.name} would want to go.`], {
      hypothesis_template: "{}",
      multi_label: true,
    });
    const want = out.scores[0] ?? 0;

    answers[`destination_${r.id}`] = {
      type: "choice",
      value: want >= WANTS ? place.id : "stay",
      probabilities: { [place.id]: want, stay: 1 - want },
    };
    answers[`reaction_${r.id}`] = {
      type: "choice",
      value: want >= WANTS ? "drawn_in" : want < NOT_FOR_ME ? "not_for_me" : "carry_on",
      probabilities: null,
    };
    onResident?.(i + 1, input.residents.length);
  }

  return { answers, place: place.id };
}
