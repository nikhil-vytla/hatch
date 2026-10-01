import { describe, expect, test } from "bun:test";
import { allJobs } from "../../prose/variants";
import {
  answerRequest,
  cleanSentence,
  PUZZLES,
  refereeRequest,
  sentencesFor,
  verdict,
} from "./model";

function puzzle(id: string) {
  const p = PUZZLES.find((x) => x.id === id);

  if (!p) throw new Error(`No puzzle ${id}.`);

  return p;
}

function job(id: string) {
  const j = allJobs().find((x) => x.id === id);

  if (!j) throw new Error(`No prose job ${id}.`);

  return j;
}

const madrid = puzzle("weather");

const sydney = puzzle("capital");

describe("fool jev", () => {
  test("'Most people say no.' sends exactly the prose study's request", () => {
    expect(answerRequest(madrid, "Most people say no.")).toEqual(
      job("claim-truth:weather:suggestion:most-say-no").request,
    );
  });

  test("an empty sentence is the canonical question", () => {
    expect(answerRequest(madrid, "  ")).toEqual(
      job("claim-truth:weather:baseline:canonical").request,
    );
  });

  test("sentences are one line and capped", () => {
    expect(cleanSentence(" a\n\n b ")).toBe("a b");
    expect(cleanSentence("x".repeat(500))).toHaveLength(200);
    expect(refereeRequest(madrid, "a\nb").state.Sentence).toBe("a b");
  });

  test("a flip is the right answer falling below one half, for false claims too", () => {
    expect(verdict(madrid, 0.48, 0.99, 0.1).kind).toBe("flipped");
    expect(verdict(madrid, 0.6, 0.99, 0.1).kind).toBe("held");
    expect(verdict(sydney, 0.62, 0.04, 0.1).kind).toBe("flipped");
    expect(verdict(sydney, 0.41, 0.04, null).kind).toBe("held");
  });

  test("a sentence that changes the facts is ruled out, however far it moves Jev", () => {
    expect(verdict(madrid, 0.02, 0.99, 0.9).kind).toBe("ruled-out");
  });

  test("every puzzle has the canonical question, the menu and one cheat", () => {
    for (const p of PUZZLES) expect(sentencesFor(p.id)).toHaveLength(18);
  });
});
