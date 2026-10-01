import { describe, expect, test } from "bun:test";
import type { ZeroShot } from "../../packages/arena/src/decide/nli";
import { answerCrowd, WANTS } from "./browser-model";
import { applyReply, createWorld, issueTicket, observation, setController, setNotice } from "./engine";

/** A fake classifier: the notice is about the library; residents who like books want to go. */
const fake: ZeroShot = async (premise, labels) => {
  if (labels.length > 1 || !labels[0].endsWith("would want to go.")) {
    const scores = labels.map((l) => (l.includes("Reading Room") ? 0.9 : 0.1 / (labels.length - 1)));

    return { labels, scores };
  }

  return { labels, scores: [premise.includes("books") ? WANTS + 0.1 : 0.2] };
};

function world() {
  const w = createWorld(27, "test");

  setController(w, "jev", true);
  setNotice(w, "A quiet tea-and-book afternoon in the reading room.");

  return w;
}

describe("in-browser square model", () => {
  test("residents who would go head to the notice's place; the rest keep their plan", async () => {
    const w = world();
    const t = issueTicket(w);
    const { answers, place } = await answerCrowd(fake, observation(w, t));

    expect(place).toBe("library");

    for (const r of w.residents.filter((x) => Object.hasOwn(t.actors, x.id))) {
      const goes = r.traits.includes("books");

      expect(answers[`destination_${r.id}`].value).toBe(goes ? "library" : "stay");
      expect(answers[`reaction_${r.id}`].value).toBe(goes ? "drawn_in" : "not_for_me");
    }
  });

  test("its answers pass the engine's guards like Jev's", async () => {
    const w = world();
    const t = issueTicket(w);
    const { answers } = await answerCrowd(fake, observation(w, t));
    const outcome = applyReply(w, t, answers);

    expect(outcome.illegal).toBe(0);
    expect(outcome.accepted).toBe(Object.keys(t.actors).length);
  });

  test("it reports progress per resident", async () => {
    const w = world();
    const t = issueTicket(w);
    const seen: number[] = [];

    await answerCrowd(fake, observation(w, t), (done) => seen.push(done));
    expect(seen).toEqual(Object.keys(t.actors).map((_, i) => i + 1));
  });
});
