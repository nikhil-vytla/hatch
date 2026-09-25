import { expect, test } from "bun:test";
import type { Entry, Event, Proposal } from "@strive/protocol";
import { learnedNotice, noticeFor } from "./notify";

const PROPOSAL: Proposal = {
  artifact: { kind: "memory" },
  content: "- Run `bun test src`.\n",
  summary: "How to run the tests",
  rationale: "The root run needs a display.",
  evidence: [],
  prediction: "No session runs the root suite first.",
};

const journal = (...events: Event[]): Entry[] => events.map((event, i) => ({ seq: i + 1, tsMs: 0, event }));

/** The notice for a journal ending with its last entry. */
function noticeAtEnd(entries: Entry[]) {
  const last = entries.at(-1);

  if (!last) throw new Error("an empty journal");

  return learnedNotice(entries, last, "app");
}

test("a learning run that ends with proposals is worth a notice; one with none, or a failed one, isn't", () => {
  const ask: Event = { type: "learnRequested", sessions: [] };
  const made: Event = { type: "proposalMade", proposal: PROPOSAL };
  const done: Event = { type: "turnEnded", turn: 1, reason: { kind: "done" } };
  expect(noticeAtEnd(journal(ask, made, made, done))).toEqual({
    title: "strive learned something",
    body: "app: 2 proposals to review",
  });
  // An earlier run's proposals aren't this one's.
  const second: Event = { type: "turnEnded", turn: 2, reason: { kind: "done" } };
  expect(noticeAtEnd(journal(ask, made, done, ask, second))).toBeUndefined();
  const failed: Event = { type: "turnEnded", turn: 1, reason: { kind: "failed", error: "HTTP 500" } };
  expect(noticeAtEnd(journal(ask, made, failed))).toBeUndefined();
});

test("a waiting approval, a finish and a failure are worth a notice; an interrupt and the rest aren't", () => {
  expect(noticeFor({ type: "approvalRequested", effect: 1, description: "run: rm -rf build" }, "Fix it")).toEqual({
    title: "strive needs your approval",
    body: "Fix it: allow it to run: rm -rf build?",
  });
  expect(noticeFor({ type: "turnEnded", turn: 1, reason: { kind: "done" } }, "Fix it")?.title).toBe("strive finished");
  expect(noticeFor({ type: "turnEnded", turn: 1, reason: { kind: "failed", error: "HTTP 429" } }, "Fix it")?.body).toBe(
    "Fix it: HTTP 429",
  );
  expect(noticeFor({ type: "turnEnded", turn: 1, reason: { kind: "interrupted" } }, "Fix it")).toBeUndefined();
  expect(noticeFor({ type: "userMessage", text: "hi" }, "Fix it")).toBeUndefined();
});
