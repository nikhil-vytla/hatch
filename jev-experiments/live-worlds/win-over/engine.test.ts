import { describe, expect, test } from "bun:test";
import type { ZeroShot } from "../../packages/arena/src/decide/nli";
import { Brain, type JevReply } from "./brain";
import { lineRequest, merge, reactionRequest, split, toHearDecision } from "./decide";
import {
  advance,
  applyGossip,
  applyHear,
  createWorld,
  goal,
  inEarshot,
  score,
  startGoal,
  VIEW,
  type Decision,
  type World,
} from "./engine";
import { camera, toWorld } from "./render";

const decision = (over: Partial<Decision>): Decision => ({
  kind: "hear",
  said: "hi",
  believes: 0.5,
  friendly: 0.5,
  warmer: 0.5,
  action: "carry_on",
  model: "test",
  ms: 1,
  at: 0,
  ...over,
});

function started(): World {
  const w = createWorld(5, 48);

  startGoal(w, "gig");

  return w;
}

/** A fake classifier: greetings are friendly and honest; anyone hears "come" when the gig is mentioned. */
const fake: ZeroShot = async (premise, labels) => {
  const friendly = premise.includes("Hi") || premise.includes("gig");
  const scores = labels.map((l) => {
    if (l.includes("greeting")) return premise.includes("Hi") ? 0.9 : 0.02;
    if (l.includes("threat")) return premise.includes("regret") ? 0.9 : 0.02;
    if (l === "This is friendly." || l.endsWith(" likes this.")) return friendly ? 0.9 : 0.1;
    if (l === "The speaker is being honest.") return 0.6;
    if (l.includes(" will go to ")) return premise.includes("gig") ? 0.9 : 0.02;
    if (l.includes(" walks away.")) return premise.includes("regret") ? 0.9 : 0.02;
    if (l.includes(" believes ")) return 0.9;
    if (l.includes(" will repeat ")) return 0.9;

    return 0.05;
  });

  return { labels, scores };
};

describe("win over: the world", () => {
  test("48 residents start neutral and move on load, before any goal", () => {
    const w = createWorld();

    expect(w.residents).toHaveLength(48);
    expect(w.residents.every((r) => r.mood === 2)).toBe(true);

    const before = w.residents.map((r) => [r.x, r.y]);

    for (let i = 0; i < 300; i++) advance(w, 1 / 30);

    expect(w.residents.some((r, i) => r.x !== before[i][0] || r.y !== before[i][1])).toBe(true);
    expect(w.t).toBe(0);
  });

  test("the clock runs 1 pm to 5 pm and ends the afternoon", () => {
    const w = started();

    for (let i = 0; i < w.length * 2 + 2; i++) advance(w, 0.5);

    expect(w.over).toBe(true);
  });

  test("the small-screen camera follows you, stops at the edges, and maps clicks back", () => {
    const w = started();

    w.player.x = 20;
    w.player.y = 300;

    const c = camera(w, 2);

    expect(c.x).toBe(0);
    expect(toWorld(c, VIEW.width / 2, VIEW.height / 2)).toEqual({ x: VIEW.width / 4, y: c.y + VIEW.height / 4 });
    expect(camera(w, 1)).toEqual({ zoom: 1, x: 0, y: 0 });
  });

  test("earshot is the nearest six within range", () => {
    const w = started();

    for (const [i, r] of w.residents.entries()) Object.assign(r, { x: w.player.x + i * 3, y: w.player.y });

    const near = inEarshot(w);

    expect(near).toHaveLength(6);
    expect(near[0].id).toBe("r0");
  });
});

describe("win over: decisions", () => {
  test("a warm line raises mood; a threat lowers it and they steer clear", () => {
    const w = started();
    const [a, b] = w.residents;

    applyHear(w, a, decision({ friendly: 0.9, warmer: 0.9, action: "come" }));
    applyHear(w, b, decision({ friendly: 0.05, warmer: 0.2, intent: "threat", action: "avoid" }));

    expect(a.mood).toBe(3);
    expect(a.plan).toBe("come");
    expect(b.mood).toBe(0);
    expect(b.plan).toBe("avoid");
    expect(b.glyph).toBe("!");
  });

  test("nobody comes to an event run by someone they dislike", () => {
    const w = started();
    const r = w.residents[0];

    r.mood = 1;
    applyHear(w, r, decision({ friendly: 0.1, warmer: 0.1, action: "come" }));
    expect(r.plan).toBe("avoid");
  });

  test("a neutral resident who says they'll come doesn't commit until they like you", () => {
    const w = started();
    const r = w.residents[0];

    applyHear(w, r, decision({ friendly: 0.5, warmer: 0.5, action: "come" }));
    expect([r.mood, r.plan]).toEqual([2, "carry_on"]);
    applyHear(w, r, decision({ friendly: 0.9, warmer: 0.8, action: "come" }));
    expect([r.mood, r.plan]).toEqual([3, "come"]);
  });

  test("gossip spreads when a teller meets someone, and believed cold gossip turns them", () => {
    const w = started();
    const [teller, listener] = w.residents;

    applyHear(w, teller, decision({ friendly: 0.05, warmer: 0.1, intent: "lie", action: "gossip" }));
    expect(teller.rumour?.tone).toBe("cold");

    Object.assign(listener, { x: teller.x + 5, y: teller.y, tx: teller.x + 5, ty: teller.y, linger: 99 });
    Object.assign(teller, { tx: teller.x, ty: teller.y, linger: 99 });

    const { meetings } = advance(w, 1 / 30);
    const m = meetings.find((x) => x.listener === listener);

    expect(m).toBeDefined();

    if (!m) return;

    applyGossip(w, m, decision({ kind: "gossip", believes: 0.9, passOn: 0.9 }));
    expect(listener.mood).toBe(1);
    expect(listener.rumour?.origin).toBe(teller.name);
    expect(w.spread[teller.name].cold).toBe(1);
  });

  test("news travels: anyone whose opinion moved carries it, even without choosing to gossip", () => {
    const w = started();
    const [warmed, unmoved] = w.residents;

    applyHear(w, warmed, decision({ friendly: 0.9, warmer: 0.9, action: "carry_on" }));
    applyHear(w, unmoved, decision({ friendly: 0.5, warmer: 0.5, action: "carry_on" }));
    expect(warmed.rumour?.tone).toBe("warm");
    expect(unmoved.rumour).toBeNull();
  });

  test("disbelieved gossip changes nothing", () => {
    const w = started();
    const [teller, listener] = w.residents;

    teller.rumour = { id: 1, tone: "cold", says: "the newcomer is a fraud", from: teller.name, origin: teller.name };
    applyGossip(w, { teller, listener, rumour: teller.rumour }, decision({ kind: "gossip", believes: 0.2, passOn: 0.9 }));
    expect(listener.mood).toBe(2);
    expect(listener.rumour).toBeNull();
  });

  test("the score counts who still plans to come, and names the loudest gossip", () => {
    const w = started();

    for (const r of w.residents.slice(0, 21)) applyHear(w, r, decision({ friendly: 0.9, warmer: 0.9, action: "come" }));

    w.spread.Nia = { warm: 0, cold: 7 };

    const s = score(w);

    expect(s.got).toBe(21);
    expect(s.verdict).toBe("21 of 48 came to your gig. You did it.");
    expect(s.detail).toBe("Nia told 7 people you were trouble.");
  });
});

describe("win over: the brain", () => {
  test("the local model judges the line once and each listener once", async () => {
    const w = started();
    const calls: string[] = [];
    const counting: ZeroShot = async (premise, labels, o) => {
      calls.push(premise);

      return fake(premise, labels, o);
    };
    const brain = new Brain(() => w, { kind: "local", name: "MobileBERT", classify: counting });
    const listeners = w.residents.slice(0, 3);

    brain.hear({ kind: "say", text: "Hi! Come to my gig at five." }, listeners);

    while (brain.pending) await new Promise((r) => setTimeout(r, 1));

    expect(listeners.every((r) => r.plan === "come" && r.mood === 3 && !r.busy)).toBe(true);
    expect(w.stats.byModel.MobileBERT).toBe(3);
    // Line: one intent choice and two yes/nos; each listener: one yes/no and one choice.
    expect(calls).toHaveLength(3 + 3 * 2);
  });

  test("Jev gets one batched call for a line and all its listeners, and is costed", async () => {
    const w = started();
    const asked: Record<string, unknown>[] = [];
    const ask = async (_state: unknown, questions: Record<string, unknown>): Promise<JevReply> => {
      asked.push(questions);

      const answers: JevReply["answers"] = {};

      for (const k of Object.keys(questions)) {
        if (k.endsWith("__intent")) answers[k] = { value: "threat", probabilities: { threat: 0.9, greeting: 0.1 } };
        else if (k.endsWith("__action")) answers[k] = { value: "avoid", probabilities: { avoid: 0.8, come: 0.2 } };
        else answers[k] = { value: 0.1 };
      }

      return { answers, latency_ms: 240, usage: { input_tokens: 1000 } };
    };
    const brain = new Brain(() => w, { kind: "jev", name: "Jev", ask });
    const listeners = w.residents.slice(0, 4);

    brain.hear({ kind: "say", text: "Come to my gig or you'll regret it." }, listeners);

    while (brain.pending) await new Promise((r) => setTimeout(r, 1));

    expect(asked).toHaveLength(1);
    expect(Object.keys(asked[0])).toHaveLength(3 + 4 * 2);
    expect(listeners.every((r) => r.plan === "avoid" && r.mood === 0)).toBe(true);
    expect(brain.costUsd).toBeCloseTo(0.000042, 9);
  });

  test("merge and split round-trip a resident's questions", () => {
    const w = started();
    const r = w.residents[0];
    const e = { kind: "say" as const, text: "Hi" };
    const m = merge([{ key: "line", req: lineRequest(e) }, { key: r.id, req: reactionRequest(r, e, goal("gig")) }]);

    expect(Object.keys(m.questions)).toEqual(["line__intent", "line__honest", "line__friendly", "r0__warmer", "r0__action"]);

    const d = toHearDecision(
      split({ line__intent: { value: "greeting" }, line__honest: { value: 0.8 } }, "line"),
      split({ r0__action: { value: "approach" }, r0__warmer: { value: 0.7 } }, "r0"),
      e,
      "Jev",
      1,
      0,
    );

    expect([d.intent, d.believes, d.action, d.warmer]).toEqual(["greeting", 0.8, "approach", 0.7]);
  });
});
