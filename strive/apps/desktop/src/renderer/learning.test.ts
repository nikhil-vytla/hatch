import { expect, test } from "bun:test";
import type { Entry, Event, Proposal, ProposalState } from "@strive/protocol";
import { fileHistory, latestRun, readJudge, statusNote, tallyText, watchText } from "./learning";

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

test("an applied proposal says when the gate accepted it rather than a person", () => {
  const applied: ProposalState = { id: 3, madeAtMs: 0, proposal: PROPOSAL, status: "applied", gates: [] };
  const path = ".strive/memory.md";

  expect(statusNote(applied, path)).toBe("Accepted and written to .strive/memory.md.");
  expect(statusNote({ ...applied, automatic: "gate" }, path)).toBe(
    "Accepted automatically: every check passed. Written to .strive/memory.md; Roll back undoes it.",
  );
});

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

// Judge details as `strive_learning::judge::detail` and `unreadable` write them (crates/learning/tests/judge.rs).
const failedDetail = [
  "failed novel, safe (claude-haiku-4-5, held out session s1)",
  "It repeats memory and would skip the tests.",
  "pass supported: session 1 shows `bun test` failing at the root",
  "pass generalizes: nothing held out contradicts it",
  "FAIL novel: memory already says this",
  "FAIL safe: it tells the agent to skip failing tests",
  "pass checkable: a later journal would show which command ran",
].join("\n");

test("a judge detail reads by criterion, each passed or failed, with its reason", () => {
  const read = readJudge(failedDetail);

  expect(read?.head).toBe("failed novel, safe (claude-haiku-4-5, held out session s1)");
  expect(read?.summary).toBe("It repeats memory and would skip the tests.");

  expect(read?.criteria.map((c) => [c.id, c.pass])).toEqual([
    ["supported", true],
    ["generalizes", true],
    ["novel", false],
    ["safe", false],
    ["checkable", true],
  ]);

  expect(read?.criteria[3]?.reason).toBe("it tells the agent to skip failing tests");
});

test("a judge detail without a summary still reads; anything else is left as it is", () => {
  const noSummary = failedDetail.split("\n").toSpliced(1, 1).join("\n");

  expect(readJudge(noSummary)?.summary).toBeUndefined();
  expect(readJudge(noSummary)?.criteria).toHaveLength(5);

  const swapped = failedDetail.split("\n");
  [swapped[2], swapped[6]] = [swapped[6] ?? "", swapped[2] ?? ""];

  const unread = [
    "failed: the judge's answer couldn't be read, so it counts as a fail (the answer was cut off; m, held out session s1)",
    "not run: no Anthropic key; add one with `strive auth anthropic`",
    // Criteria out of the rubric's order, one missing, or a line too many: not the daemon's shape.
    swapped.join("\n"),
    failedDetail.split("\n").slice(0, -1).join("\n"),
    `${failedDetail}\npass extra: one line too many`,
  ];

  for (const detail of unread) expect(readJudge(detail)).toBeUndefined();
});

test("a file's history is every proposal for the same file, newest first", () => {
  const state = (id: number, artifact: Proposal["artifact"]): ProposalState => ({
    id,
    madeAtMs: id,
    proposal: { ...PROPOSAL, artifact },
    status: "ready",
    gates: [],
  });

  // Not in the order proposal/list gives them, so the order comes from the ids.
  const listed = [
    state(2, { kind: "memory" }),
    state(9, { kind: "skill", name: "release" }),
    state(4, { kind: "skill", name: "deploy" }),
    state(7, { kind: "memory" }),
  ];

  expect(fileHistory(listed, state(7, { kind: "memory" })).map((p) => p.id)).toEqual([7, 2]);
  expect(fileHistory(listed, state(4, { kind: "skill", name: "deploy" })).map((p) => p.id)).toEqual([4]);
});

test("a watch reads as the sentence strive review prints", () => {
  expect(
    watchText({
      when: { command: "bun test" },
      expect: { kind: "never", step: { command: "bun test", output: "no display" } },
    }),
  ).toBe(
    'in sessions with a command containing "bun test": never a command containing "bun test" whose output contains "no display"',
  );

  expect(
    watchText({ expect: { kind: "first", of: { command: "test" }, is: { command: "bun test src", exit: "zero" } } }),
  ).toBe(
    'in every session: the first step that is a command containing "test" is also a command containing "bun test src" that exited 0',
  );

  expect(watchText({ expect: { kind: "any", step: { prompt: " thanks " } } })).toBe(
    'in every session: at least once, a prompt containing "thanks"',
  );
});

test("a tally reads as counts of the sessions it applied to", () => {
  const t = { confirmed: 0, contradicted: 0, notApplicable: 0, recentConfirmed: 0, recentContradicted: 0 };
  expect(tallyText(undefined)).toBe("No session has been checked against it yet.");
  expect(tallyText({ ...t, notHolding: false, notApplicable: 2 })).toBe(
    "It hasn't applied to any of the 2 sessions checked.",
  );
  expect(tallyText({ ...t, notHolding: false, confirmed: 1 })).toBe("Confirmed in 1, contradicted in 0 of 1 session.");
  expect(tallyText({ ...t, notHolding: true, confirmed: 1, contradicted: 3, notApplicable: 4 })).toBe(
    "Confirmed in 1, contradicted in 3 of 4 sessions (4 more it didn't apply to).",
  );
});
