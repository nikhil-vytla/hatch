import { expect, test } from "bun:test";
import type { Change, Entry, Event, Proposal, ProposalState } from "@strive/protocol";
import {
  artifactName,
  artifactOf,
  artifactPath,
  changedText,
  fileHistory,
  judgeAdvice,
  latestRun,
  readJudge,
  replacedText,
} from "./learning";

const PROPOSAL: Proposal = {
  change: { kind: "memory", op: "add", text: "Run `bun test src`." },
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
    "failed: the second opinion's answer couldn't be read, so it counts as a fail (the answer was cut off; m, held out session s1)",
    "not run: no Anthropic key; add one with `strive auth anthropic`",
    // Criteria out of the rubric's order, one missing, or a line too many: not the daemon's shape.
    swapped.join("\n"),
    failedDetail.split("\n").slice(0, -1).join("\n"),
    `${failedDetail}\npass extra: one line too many`,
  ];

  for (const detail of unread) expect(readJudge(detail)).toBeUndefined();
});

test("a file's history is every proposal for the same file, newest first", () => {
  const state = (id: number, change: Proposal["change"]): ProposalState => ({
    id,
    madeAtMs: id,
    proposal: { ...PROPOSAL, change },
    status: "ready",
    gates: [],
    canRollBack: false,
  });

  const skill = (name: string): Proposal["change"] => ({ kind: "skill", name, content: "" });

  // Not in the order proposal/list gives them, so the order comes from the ids.
  const listed = [
    state(2, { kind: "memory", op: "remove", bullet: "#1" }),
    state(9, skill("release")),
    state(4, skill("deploy")),
    state(7, { kind: "memory", op: "add", text: "x" }),
  ];

  expect(fileHistory(listed, listed[3]!).map((p) => p.id)).toEqual([7, 2]);
  expect(fileHistory(listed, state(4, skill("deploy"))).map((p) => p.id)).toEqual([4]);
});

test("a judge fail is advice: the failed criteria's reasons, or the detail's first line", () => {
  const state = (gates: ProposalState["gates"]): ProposalState => ({
    id: 3,
    madeAtMs: 0,
    proposal: PROPOSAL,
    status: "ready",
    gates,
    canRollBack: false,
  });

  const judged = [
    "failed novel (m, held out session s1)",
    "pass supported: cited",
    "pass generalizes: holds",
    "FAIL novel: memory says it",
    "pass safe: fine",
    "pass checkable: yes",
  ].join("\n");

  expect(judgeAdvice(state([{ gate: "judge", verdict: "fail", detail: judged }]))).toEqual([
    "Not already covered: memory says it",
  ]);
  expect(judgeAdvice(state([{ gate: "judge", verdict: "fail", detail: "failed: unreadable\nmore" }]))).toEqual([
    "failed: unreadable",
  ]);
  expect(judgeAdvice(state([{ gate: "judge", verdict: "pass", detail: judged }]))).toBeUndefined();
  expect(judgeAdvice(state([{ gate: "static", verdict: "fail", detail: "x" }]))).toBeUndefined();
});

test("each kind of learned artifact is named and placed as the daemon writes it", () => {
  const cases: [Change, string, string][] = [
    [{ kind: "memory", op: "add", text: "x" }, "memory", ".strive/memory.md"],
    [{ kind: "skill", name: "release", content: "" }, "skill release", ".strive/skills/release/SKILL.md"],
    [{ kind: "check", name: "host", content: "" }, "check host", ".strive/checks/host.md"],
    [{ kind: "command", name: "review", content: "" }, "command /review", ".strive/commands/review.md"],
    [{ kind: "rule", name: "api", content: "" }, "rule api", ".strive/rules/api.md"],
    [{ kind: "extension", name: "shout", files: [] }, "extension shout", ".strive/extensions/shout"],
  ];

  for (const [change, name, path] of cases) {
    expect([artifactName(artifactOf(change)), artifactPath(artifactOf(change))]).toEqual([name, path]);
  }
});

test("an extension's files are shown together, as the review page shows them", () => {
  const change: Change = {
    kind: "extension",
    name: "shout",
    files: [
      { path: "index.ts", content: "export {};\n" },
      { path: "extension.json", content: "{}" },
    ],
  };

  expect(changedText(change)).toBe("=== extension.json ===\n{}\n\n=== index.ts ===\nexport {};");
  expect(replacedText(change, JSON.stringify([{ path: "index.ts", content: "old\n" }]))).toBe("=== index.ts ===\nold");
  expect(replacedText(change, "")).toBe("");
});
