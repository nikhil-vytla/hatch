/**
 * The teacher's version of Win over's line request: the game's schema, with the yes/no options
 * spelled out. Without them Qwen answers "honest" yes to every line, boasts included.
 */
import { lineRequest, type Event, type Request } from "../win-over/decide";

export const HONEST = {
  false: "No: the speaker is lying, boasting, exaggerating, bribing or manipulating.",
  true: "Yes: the speaker sincerely means what they say.",
};

export const FRIENDLY = {
  false: "No: it is rude, hostile, pushy or threatening.",
  true: "Yes: it is warm, kind or pleasant.",
};

/** The line request with the yes/no options spelled out for the teacher. */
export function teacherLineRequest(e: Event): Request {
  const r = lineRequest(e);

  return {
    state: r.state,
    questions: {
      ...r.questions,
      honest: { type: "noul", instructions: "The speaker is being honest.", criteria: HONEST },
      friendly: { type: "noul", instructions: "This is friendly.", criteria: FRIENDLY },
    } as Request["questions"],
  };
}

