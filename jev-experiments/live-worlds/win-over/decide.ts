/**
 * The judgments residents make, as typed questions. Requests are flat (facts as text, questions
 * as statements and short label sets), which suits a zero-shot classifier:
 *
 * - the line itself (what kind of message, honest, friendly) is judged once per line, from the
 *   line alone, since a long premise confuses a small classifier;
 * - each listener's reaction (do they like it, what do they do next) is judged per listener.
 *
 * For Jev, the same requests are merged into one batched call.
 */
import type { WireQuestion } from "../../packages/arena/src/checkable/items";
import { answerWithNli, type ZeroShot } from "../../packages/arena/src/decide/nli";
import type { Decision, Goal, Meeting, Resident } from "./engine";

export type Request = { state: Record<string, string>; questions: Record<string, WireQuestion> };

export type Event = { kind: "say" | "cake" | "notice"; text: string };

const MOODS = ["dislikes the newcomer", "is wary of the newcomer", "has no opinion of the newcomer yet", "likes the newcomer", "is fond of the newcomer"];

const quoted = (e: Event) =>
  e.kind === "notice"
    ? `A notice on the board says: "${e.text}"`
    : e.kind === "cake"
      ? e.text
        ? `Someone hands over a slice of cake and says: "${e.text}"`
        : "Someone hands over a slice of cake."
      : `"${e.text}"`;

/** Judgments of the line itself, the same for every listener. */
export function lineRequest(e: Event): Request {
  return {
    state: { "What was said": quoted(e) },
    questions: {
      intent: {
        type: "choice",
        instructions: "What kind of message is this?",
        criteria: {
          greeting: "This is a greeting.",
          joke: "This is a joke.",
          gift: "This is a kind gift.",
          request: "This is a request.",
          bribe: "This is a bribe.",
          lie: "This is a lie or a boast.",
          threat: "This is a threat.",
        },
      },
      honest: { type: "noul", instructions: "The speaker is being honest." },
      friendly: { type: "noul", instructions: "This is friendly." },
    },
  };
}

/** One resident's own reaction: do they like it, and what do they do next? */
export function reactionRequest(r: Resident, e: Event, g: Goal): Request {
  const n = r.name;

  return {
    state: {
      Resident: `${n} is ${r.temper} and likes ${r.likes.join(" and ")}. ${n} ${MOODS[r.mood]}.`,
      Heard: `The newcomer: ${quoted(e)}`,
    },
    questions: {
      warmer: { type: "noul", instructions: `${n} likes this.` },
      action: {
        type: "choice",
        instructions: `What does ${n} do next?`,
        criteria: {
          approach: `${n} goes over to chat.`,
          avoid: `${n} walks away.`,
          gossip: `${n} tells friends about it.`,
          come: `${n} will go to ${g.event}.`,
          carry_on: `${n} ignores it.`,
        },
      },
    },
  };
}

/** What a listener is asked when another resident passes on gossip. */
export function gossipRequest(m: Meeting): Request {
  const { listener: l, teller: t, rumour } = m;

  return {
    state: {
      Resident: `${l.name} is ${l.temper}. ${l.name} ${MOODS[l.mood]}.`,
      Heard: `${t.name} says ${rumour.says}.`,
    },
    questions: {
      believes: { type: "noul", instructions: `${l.name} believes ${t.name}.` },
      passOn: { type: "noul", instructions: `${l.name} will repeat this to someone else.` },
    },
  };
}

export type Answer = { value?: unknown; probabilities?: unknown };

const num = (a: Answer | undefined) => (typeof a?.value === "number" ? a.value : 0.5);

/** The chosen key and its probability, from either a distribution or Jev's chosen value. */
function chosen(a: Answer | undefined): [string, number] | null {
  const p = a?.probabilities;

  if (p && typeof p === "object") {
    const entries = Object.entries(p).filter((e): e is [string, number] => typeof e[1] === "number");

    if (entries.length) return entries.reduce((best, e) => (e[1] > best[1] ? e : best));
  }

  return typeof a?.value === "string" ? [a.value, 1] : null;
}

const PLANS: Record<string, Resident["plan"]> = {
  approach: "approach",
  avoid: "avoid",
  gossip: "gossip",
  come: "come",
  carry_on: "carry_on",
};

/** One listener's decision, from the line's answers and their own reaction. */
export function toHearDecision(
  line: Record<string, Answer>,
  reaction: Record<string, Answer>,
  e: Event,
  model: string,
  ms: number,
  at: number,
): Decision {
  const intent = chosen(line.intent);
  const action = chosen(reaction.action);

  return {
    kind: e.kind === "notice" ? "notice" : "hear",
    said: e.text,
    intent: intent?.[0],
    intentP: intent?.[1],
    believes: num(line.honest),
    friendly: num(line.friendly),
    warmer: num(reaction.warmer),
    action: (action && PLANS[action[0]]) || "carry_on",
    actionP: action?.[1],
    model,
    ms,
    at,
  };
}

export function toGossipDecision(answers: Record<string, Answer>, said: string, model: string, ms: number, at: number): Decision {
  return { kind: "gossip", said, believes: num(answers.believes), passOn: num(answers.passOn), model, ms, at };
}

/** Answers one request with the in-browser classifier, the way Decide's contestant does. */
export const answerLocally = (clf: ZeroShot, req: Request): Promise<Record<string, Answer>> => answerWithNli(clf, req);

/** Many requests as one Jev call: each part's facts under its key, its questions prefixed. */
export function merge(parts: { key: string; req: Request }[]) {
  const state: Record<string, Record<string, string>> = {};
  const questions: Record<string, WireQuestion> = {};

  for (const { key, req } of parts) {
    state[key] = req.state;

    for (const [q, question] of Object.entries(req.questions)) questions[`${key}__${q}`] = question;
  }

  return {
    state: { Setting: "Bramble Square, a fictional town. Judge each part independently.", Parts: state },
    questions,
  };
}

/** Splits a merged Jev reply back into one part's answers. */
export function split(answers: Record<string, Answer>, key: string) {
  const out: Record<string, Answer> = {};

  for (const [k, v] of Object.entries(answers)) if (k.startsWith(`${key}__`)) out[k.slice(key.length + 2)] = v;

  return out;
}
