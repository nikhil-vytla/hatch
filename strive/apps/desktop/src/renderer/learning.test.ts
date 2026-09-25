import { expect, test } from "bun:test";
import type { Entry, Event, Proposal } from "@strive/protocol";
import { latestRun } from "./learning";

const PROPOSAL: Proposal = {
  artifact: { kind: "memory" },
  content: "- Run `bun test src`.\n",
  summary: "How to run the tests",
  rationale: "The root run needs a display.",
  evidence: [],
  prediction: "No session runs the root suite first.",
};

const journal = (...events: Event[]): Entry[] => events.map((event, i) => ({ seq: i + 1, tsMs: i * 1000, event }));

const ask: Event = { type: "learnRequested", sessions: [] };

const reading: Event = {
  type: "assistantMessage",
  turn: 1,
  text: "",
  toolCalls: [{ id: "c1", name: "read_session" }],
  message: {},
};

test("a run is running from its request until its own turn ends, saying what the learner is doing", () => {
  expect(latestRun(journal({ type: "userMessage", text: "not a request" }))).toBeUndefined();
  expect(latestRun(journal(ask))).toMatchObject({ asked: 1, running: true, step: undefined, made: [] });

  expect(latestRun(journal(ask, { type: "turnStarted", turn: 1, throughSeq: 1 }, reading))).toMatchObject({
    running: true,
    step: "Reading a session",
  });

  const done = journal(
    ask,
    { type: "turnStarted", turn: 1, throughSeq: 1 },
    reading,
    { type: "proposalMade", proposal: PROPOSAL },
    { type: "turnEnded", turn: 1, reason: { kind: "done" } },
  );

  expect(latestRun(done)).toEqual({
    asked: 1,
    askedMs: 0,
    running: false,
    step: undefined,
    stopped: undefined,
    made: [4],
  });
});

test("a request made while an earlier turn runs waits for a turn of its own", () => {
  const queued = journal(ask, { type: "turnStarted", turn: 1, throughSeq: 1 }, ask, {
    type: "turnEnded",
    turn: 1,
    reason: { kind: "done" },
  });

  expect(latestRun(queued)).toMatchObject({ asked: 3, running: true });
});

test("a run that stops says why", () => {
  const failed = journal(
    ask,
    { type: "turnStarted", turn: 1, throughSeq: 1 },
    { type: "turnEnded", turn: 1, reason: { kind: "failed", error: "no API key for anthropic" } },
  );

  expect(latestRun(failed)).toMatchObject({ running: false, stopped: "no API key for anthropic" });
});
