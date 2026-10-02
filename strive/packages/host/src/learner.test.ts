// The learner, run by the real host against a scripted daemon and model.
// The daemon's learning methods (M7) aren't built on this branch: it
// refuses `proposalMade` records and runs no static gate. FakeDaemon plays
// them per the protocol, which is the case fakes are for (orderings the
// real daemon doesn't produce yet).
import { afterEach, expect, expectTypeOf, test } from "bun:test";
import { type Static, validateToolArguments } from "@earendil-works/pi-ai";
import type {
  BulletUsage,
  AgentConfig,
  Artifact,
  Entry,
  Event,
  MemoryItem,
  LearnerContext,
  Proposal,
  SessionInfo,
  SessionReadResult,
  StriveClient,
} from "@strive/protocol";
import { FakeAnthropic, FakeDaemon, type FakeReply, type ScriptedReply } from "@strive/testkit";
import { learnerPrompt, MAX_PROPOSALS, memoryItems, ProposalParams, ReadArtifactParams } from "./learner";
import { when } from "./learning-records";
import { runHost } from "./main";

const LEARN = "01J8ZSLEARNINGAAAAAAAAAAAAA";

const W1 = "01J8ZSWORKONEAAAAAAAAAAAAAA";

const W0 = "01J8ZSWORKOLDAAAAAAAAAAAAAA";

const ELSEWHERE = "01J8ZSELSEWHEREAAAAAAAAAAA";

const CWD = "/tmp/proj";

const T0 = Date.UTC(2026, 8, 20, 9, 0);

/** What each run started in a test, stopped once it's over (a test may start two). */
let stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
});

const config = (baseUrl: string, over: Partial<AgentConfig> = {}): AgentConfig => ({
  cwd: CWD,
  model: "claude-sonnet-4-5",
  provider: "anthropic",
  baseUrl,
  contextWindow: 200_000,
  maxOutput: 1000,
  turnSeconds: 30,
  compactAtTokens: 150_000,
  instructions: [{ path: `${CWD}/AGENTS.md`, text: "Use bun, not npm." }],
  skills: [],
  checks: [],
  extensions: [],
  mcpTools: [],
  kind: "learning",
  ...over,
});

/** What `host/context` gives a run when nothing changed since the host registered. */
const context = ({ instructions, skills, learnedFiles }: AgentConfig): LearnerContext => ({
  instructions,
  skills,
  learnedFiles: learnedFiles ?? [],
});

// A work session in which the root test run fails for want of a display and
// the user says to run the host tests alone.
const workEvents: Event[] = [
  { type: "sessionStarted", format: 1, cwd: CWD, striveVersion: "0.3.0" },
  { type: "userMessage", text: "fix the failing host test" },
  { type: "turnStarted", turn: 1, throughSeq: 2 },
  {
    type: "assistantMessage",
    turn: 1,
    text: "",
    toolCalls: [{ id: "w1", name: "bash" }],
    message: {},
  },
  { type: "effectStarted", effect: 1, callId: "w1", record: { kind: "bash", command: "bun test", timeoutMs: 0 } },
  {
    type: "effectFinished",
    effect: 1,
    outcome: { kind: "done", output: "sha256:nodisplay", exitCode: 1, truncated: false },
    durationMs: 10,
  },
  { type: "turnEnded", turn: 1, reason: { kind: "interrupted" } },
  { type: "userMessage", text: "don't run the whole suite, run bun test packages/host" },
];

const workEntries: Entry[] = workEvents.map((event, i) => ({ seq: i + 1, tsMs: T0 + i * 1000, event }));

const work: SessionInfo = {
  id: W1,
  cwd: CWD,
  createdAtMs: T0,
  title: "fix the failing host test",
  lastActiveMs: T0 + 150 * 60_000,
};

const older: SessionInfo = {
  id: W0,
  cwd: CWD,
  createdAtMs: T0 - 86_400_000,
  title: "old",
  lastActiveMs: T0 - 3600_000,
};

const learningInfo: SessionInfo = { id: LEARN, cwd: CWD, createdAtMs: T0 - 1000, kind: "learning" };

const reads = new Map<string, SessionReadResult>([
  [W1, { session: work, entries: workEntries, committed: workEntries.length, tornBytes: 0 }],
  [
    ELSEWHERE,
    { session: { id: ELSEWHERE, cwd: "/tmp/other", createdAtMs: T0 }, entries: [], committed: 0, tornBytes: 0 },
  ],
  [LEARN, { session: learningInfo, entries: [], committed: 0, tornBytes: 0 }],
]);

const seqIn = (entries: Entry[], pred: (e: Event) => boolean) => entries.find((x) => pred(x.event))?.seq ?? -1;

const failSeq = seqIn(workEntries, (e) => e.type === "effectFinished");

const fixSeq = seqIn(workEntries, (e) => e.type === "userMessage" && e.text.startsWith("don't"));

const PROPOSAL: Proposal = {
  change: {
    kind: "memory",
    op: "add",
    text: "Run the host tests with `bun test packages/host`: the root `bun test` also starts the desktop suite, which needs a display.",
  },
  summary: "memory: run the host tests on their own",
  rationale: "The root test run failed for want of a display, and the user asked for the host tests alone.",
  evidence: [
    { session: W1, seqs: [failSeq, fixSeq], note: "bun test fails: no display; the user says to run packages/host" },
  ],
  prediction: "Sessions that run the host tests won't first fail with 'no display'.",
};

type StaticVerdict = { verdict: "pass" | "fail" | "skipped"; detail: string };

type Setup = {
  script: ScriptedReply[];
  /** The learning session's journal when the host attaches (a request is journaled before the host starts). */
  history?: Entry[];
  config?: Partial<AgentConfig>;
  /** The daemon's answer to a proposal: a refusal, or the static check it journals after recording it. */
  onProposal?: (p: Proposal) => { refuse: string } | StaticVerdict;
  /** A person asks again once the first turn has ended, so a second turn runs. */
  askAgain?: boolean;
};

const request = (seq: number, tsMs: number, sessions: string[] = []): Entry => ({
  seq,
  tsMs,
  event: { type: "learnRequested", sessions },
});

const started: Entry = {
  seq: 1,
  tsMs: T0 - 1000,
  event: { type: "sessionStarted", format: 1, cwd: CWD, striveVersion: "0.3.0", kind: "learning" },
};

/** Starts the host on a scripted learning session; resolves once `turns` turns have ended. */
async function learn(s: Setup, turns = 1) {
  const model = new FakeAnthropic(s.script).start();
  const journal: Entry[] = [...(s.history ?? [started, request(2, T0 + 2 * 3600_000)])];
  const recorded: Event[] = [];
  let daemon: FakeDaemon | undefined;

  const append = (event: Event): Entry => {
    const entry = { seq: (journal.at(-1)?.seq ?? 0) + 1, tsMs: Date.now(), event };
    journal.push(entry);
    // Attached clients see every entry once it's committed, after the reply that made it.
    setTimeout(() => daemon?.push("session/entry", { sessionId: LEARN, entry }), 5);

    return entry;
  };

  daemon = new FakeDaemon({
    "host/register": () => ({ result: config(model.url, s.config) }),
    "host/context": () => ({ result: context(config(model.url, s.config)) }),
    "session/attach": () => ({ result: { session: learningInfo, entries: [...journal] } }),
    "session/list": (p) => ({
      result: { sessions: [work, older, learningInfo].filter((x) => x.cwd === p.cwd), unreadable: [] },
    }),
    "session/read": (p) => {
      const read = reads.get(p.id);

      return read ? { result: read } : { error: { code: -32602, message: `no session ${p.id}` } };
    },
    "blob/get": (p) =>
      p.digest === "sha256:nodisplay"
        ? { result: { text: "error: no display for the desktop tests\n1 fail", bytes: 40 } }
        : { error: { code: -32602, message: `no blob ${p.digest}` } },
    "host/record": (p): FakeReply<"host/record"> => {
      const e = p.event;

      if (e.type === "proposalMade") {
        const answer = s.onProposal?.(e.proposal) ?? { verdict: "pass", detail: "" };

        if ("refuse" in answer) return { error: { code: -32602, message: answer.refuse } };
        recorded.push(e);
        const made = append(e);
        setTimeout(() => append({ type: "gateFinished", proposal: made.seq, gate: "static", ...answer }), 20);

        return { result: { seq: made.seq } };
      }

      recorded.push(e);
      const entry = append(e);

      if (e.type === "turnEnded" && s.askAgain && recorded.filter((r) => r.type === "turnEnded").length === 1)
        append({ type: "learnRequested", sessions: [] });

      return { result: { seq: entry.seq } };
    },
    "host/stream": () => ({ result: {} }),
  });

  let client: StriveClient | undefined;
  const fake = daemon;
  stops.push(() => {
    client?.close();
    fake.close();
    model.stop();
  });
  await daemon.listen();

  ({ client } = await runHost(daemon.socket, LEARN));
  const ended = () => recorded.filter((e) => e.type === "turnEnded").length >= turns;
  const deadline = Date.now() + 10_000;

  while (!ended() && Date.now() < deadline) await Bun.sleep(20);

  if (!ended()) throw new Error(`timed out; recorded: ${JSON.stringify(recorded.map((e) => e.type))}`);

  return { model, daemon, recorded, journal };
}

type TextBlock = { type: "text"; text: string };

type ToolResultBlock = { type: "tool_result"; tool_use_id: string; is_error?: boolean; content: TextBlock[] | string };

function isTextBlock(v: unknown): v is TextBlock {
  return typeof v === "object" && v !== null && "type" in v && v.type === "text" && "text" in v;
}

function isToolResult(v: unknown): v is ToolResultBlock {
  return (
    typeof v === "object" &&
    v !== null &&
    "type" in v &&
    v.type === "tool_result" &&
    "tool_use_id" in v &&
    "content" in v &&
    (typeof v.content === "string" || (Array.isArray(v.content) && v.content.every(isTextBlock)))
  );
}

/** A message's text: its string content, or its text blocks joined. */
const blockText = (content: TextBlock[] | string): string =>
  Array.isArray(content) ? content.flatMap((c) => (isTextBlock(c) ? [c.text] : [])).join("") : content;

/** The tool results a model request carries, by call id. */
function toolResults(req: any): Map<string, { text: string; isError: boolean }> {
  const out = new Map<string, { text: string; isError: boolean }>();

  for (const m of req.messages) {
    if (!Array.isArray(m.content)) continue;

    for (const c of m.content) {
      if (isToolResult(c)) out.set(c.tool_use_id, { text: blockText(c.content), isError: c.is_error === true });
    }
  }

  return out;
}

const toolNames = (req: any): string[] => req.tools.map((t: { name: string }) => t.name);

test("a learning request runs a turn that lists sessions, reads one, and proposes", async () => {
  const { model, daemon, recorded, journal } = await learn({
    script: [
      { toolCalls: [{ id: "t1", name: "list_sessions", input: {} }] },
      { toolCalls: [{ id: "t2", name: "read_session", input: { id: W1 } }] },
      { toolCalls: [{ id: "t3", name: "propose_change", input: PROPOSAL }] },
      { text: `I read ${W1} and proposed one memory bullet.` },
    ],
  });

  const requestSeq = seqIn(journal, (e) => e.type === "learnRequested");
  const proposalSeq = seqIn(journal, (e) => e.type === "proposalMade");

  expect(recorded.map((e) => e.type)).toEqual([
    "turnStarted",
    "assistantMessage",
    "assistantMessage",
    "assistantMessage",
    "proposalMade",
    "assistantMessage",
    "turnEnded",
  ]);
  expect(recorded[0]).toEqual({ type: "turnStarted", turn: 1, throughSeq: requestSeq });
  expect(recorded.find((e) => e.type === "proposalMade")).toEqual({
    type: "proposalMade",
    callId: "t3",
    proposal: PROPOSAL,
  });
  expect(recorded.at(-1)).toEqual({ type: "turnEnded", turn: 1, reason: { kind: "done" } });

  // The request is the prompt; the learner has its own system prompt and tools.
  const first = model.requests[0];
  expect(JSON.stringify(first.system)).toContain(`You are strive's learner for the project in ${CWD}`);
  expect(JSON.stringify(first.messages[0].content)).toContain("You haven't looked at this project before");
  expect(toolNames(first)).toEqual(["list_sessions", "read_session", "read_artifact", "propose_change"]);

  const listed = toolResults(model.requests[1]).get("t1")?.text ?? "";
  expect(listed).toContain(`${W1} "fix the failing host test", started ${when(work.createdAtMs)}`);
  expect(listed).toContain(W0);
  expect(listed).not.toContain(LEARN);

  const read = toolResults(model.requests[2]).get("t2")?.text ?? "";
  expect(read).toContain(`#${failSeq} result of #${failSeq - 1}: exit 1\n  error: no display for the desktop tests`);
  expect(read).toContain(`#${fixSeq} user: don't run the whole suite, run bun test packages/host`);

  expect(toolResults(model.requests[3]).get("t3")).toEqual({
    text: `Recorded as proposal ${proposalSeq}. It passed the static check. A person reviews it with \`strive review ${proposalSeq}\`.`,
    isError: false,
  });

  const asked = daemon.calls.filter((c) => c.method === "session/list" || c.method === "session/read");
  expect(asked).toEqual([
    { method: "session/list", params: { cwd: CWD } },
    { method: "session/read", params: { id: W1 } },
  ]);
});

test("an automatic request's prompt names the signs that started it; a person's doesn't", async () => {
  const trigger = {
    kind: "idle" as const,
    signals: [
      {
        session: W1,
        seq: fixSeq,
        kind: "correction" as const,
        detail: "don't run the whole suite, run bun test packages/host",
      },
      { session: W1, seq: failSeq + 1, kind: "failedThenPassed" as const, detail: "bun test" },
    ],
  };

  const automatic: Entry = { seq: 2, tsMs: T0, event: { type: "learnRequested", sessions: [W1], trigger } };
  const { model } = await learn({ history: [started, automatic], script: [{ text: "Nothing worth it." }] });
  const prompt = JSON.stringify(model.requests[0].messages[0].content);
  expect(prompt).toContain(`Study these work sessions: ${W1}.`);
  expect(prompt).toContain("Nobody asked for this run");
  expect(prompt).toContain(
    `- session ${W1} entry ${fixSeq}: the user corrected the agent: don't run the whole suite, run bun test packages/host`,
  );
  expect(prompt).toContain(`- session ${W1} entry ${failSeq + 1}: a command failed, then passed: bun test`);

  const person = await learn({ history: [started, request(2, T0, [W1])], script: [{ text: "Nothing worth it." }] });
  expect(JSON.stringify(person.model.requests[0].messages[0].content)).not.toContain("Nobody asked");
});

test("a person's request made from the offer to learn names the session's signs too", async () => {
  const signals = [{ session: W1, seq: fixSeq, kind: "correction" as const, detail: "no, use bun" }];
  const asked: Entry = { seq: 2, tsMs: T0, event: { type: "learnRequested", sessions: [W1], signals } };
  const { model } = await learn({ history: [started, asked], script: [{ text: "Nothing worth it." }] });
  const prompt = JSON.stringify(model.requests[0].messages[0].content);
  expect(prompt).toContain(`Study these work sessions: ${W1}.`);
  expect(prompt).toContain("The user asked for this run");
  expect(prompt).toContain(`- session ${W1} entry ${fixSeq}: the user corrected the agent: no, use bun`);
  expect(prompt).not.toContain("Nobody asked");
});

test("a person's note with their request reaches the learner as theirs", async () => {
  const note = "an automated check found the task not done";
  const asked: Entry = { seq: 2, tsMs: T0, event: { type: "learnRequested", sessions: [W1], note } };
  const { model } = await learn({ history: [started, asked], script: [{ text: "Nothing worth it." }] });
  const prompt = JSON.stringify(model.requests[0].messages[0].content);

  expect(prompt).toContain(`Study these work sessions: ${W1}.`);
  expect(prompt).toContain(`The user says about them: ${note}`);
});

test("the learner never runs a file or shell effect, even when the model asks for one", async () => {
  const mcp = { server: "fs", name: "write", description: "writes", inputSchema: { type: "object" } };

  const { model, daemon } = await learn({
    config: { mcpTools: [mcp] },
    script: [
      {
        toolCalls: [
          { id: "b", name: "bash", input: { command: "echo hi > x" } },
          { id: "w", name: "write", input: { path: ".strive/memory.md", content: "x" } },
          { id: "m", name: "mcp__fs__write", input: {} },
        ],
      },
      { text: "I can't do that." },
    ],
  });

  expect(toolNames(model.requests[0])).toEqual(["list_sessions", "read_session", "read_artifact", "propose_change"]);
  const results = toolResults(model.requests[1]);

  for (const id of ["b", "w", "m"]) expect(results.get(id)?.isError).toBe(true);
  expect(results.get("b")?.text).toContain("Tool bash not found");
  expect(daemon.calls.some((c) => c.method.startsWith("effect/"))).toBe(false);
});

test("a refused proposal reaches the model as an error it can act on, and so does a failed static check", async () => {
  const bad = { ...PROPOSAL, evidence: [{ session: ELSEWHERE, seqs: [1], note: "elsewhere" }] };

  const skill: Proposal = {
    ...PROPOSAL,
    change: { kind: "skill", name: "host-tests", content: "Run bun test packages/host." },
  };

  const others = Array.from({ length: MAX_PROPOSALS - 1 }, (_, i) => `p${i + 3}`);

  const { model, recorded } = await learn({
    onProposal: (p) =>
      p.evidence.some((e) => e.session === ELSEWHERE)
        ? { refuse: `evidence names ${ELSEWHERE}, which isn't a session of this project` }
        : p.change.kind === "skill"
          ? { verdict: "fail", detail: "a skill must start with --- frontmatter naming it" }
          : { verdict: "pass", detail: "" },
    script: [
      { toolCalls: [{ id: "p1", name: "propose_change", input: bad }] },
      { toolCalls: [{ id: "p2", name: "propose_change", input: skill }] },
      // The rest of the run's allowance, which the refusal didn't use.
      ...others.map((id) => ({ toolCalls: [{ id, name: "propose_change", input: PROPOSAL }] })),
      { text: "The proposals stand." },
    ],
  });

  const refused = toolResults(model.requests[1]).get("p1");
  expect(refused?.isError).toBe(true);
  expect(refused?.text).toBe(
    `The daemon refused this proposal, so nothing was recorded: evidence names ${ELSEWHERE}, which isn't a session of this project\nFix what it says and propose again, or drop it.`,
  );

  const failed = toolResults(model.requests[2]).get("p2");
  expect(failed?.isError).toBe(true);
  expect(failed?.text).toContain("failed the daemon's static check, so it can't be accepted: a skill must start with");

  // A refusal doesn't use up the run's allowance; a recorded one that failed does.
  const last = toolResults(model.requests.at(-1));
  expect(others.map((id) => last.get(id)?.isError)).toEqual(others.map(() => false));
  expect(recorded.filter((e) => e.type === "proposalMade").length).toBe(MAX_PROPOSALS);
});

test("each run has its own allowance of proposals", async () => {
  const calls = (turn: number, n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `t${turn}p${i}`, name: "propose_change", input: PROPOSAL }));

  const { model, recorded } = await learn(
    {
      askAgain: true,
      script: [{ toolCalls: calls(1, MAX_PROPOSALS) }, { text: "done" }, { toolCalls: calls(2, 1) }, { text: "done" }],
    },
    2,
  );

  expect(recorded.filter((e) => e.type === "proposalMade").length).toBe(MAX_PROPOSALS + 1);
  expect(toolResults(model.requests[3]).get("t2p0")?.isError).toBe(false);
});

test(`a run records at most ${MAX_PROPOSALS} proposals, even when they come in one reply`, async () => {
  const calls = [1, 2, 3, 4].map((n) => ({ id: `p${n}`, name: "propose_change", input: PROPOSAL }));
  const { model, recorded } = await learn({ script: [{ toolCalls: calls }, { text: "done" }] });

  expect(recorded.filter((e) => e.type === "proposalMade").length).toBe(MAX_PROPOSALS);
  const results = [...toolResults(model.requests[1]).values()];
  expect(results.flatMap((r) => (r.isError ? [r.text] : []))).toEqual([
    `This run has made ${MAX_PROPOSALS} proposals, the most a run may make. Nothing was recorded. End the run with your report.`,
  ]);
});

test("read_session reads only this project's work sessions", async () => {
  const { model } = await learn({
    script: [
      {
        toolCalls: [
          { id: "r1", name: "read_session", input: { id: ELSEWHERE } },
          { id: "r2", name: "read_session", input: { id: LEARN } },
        ],
      },
      { text: "done" },
    ],
  });

  const results = toolResults(model.requests[1]);
  expect(results.get("r1")).toEqual({
    text: `Session ${ELSEWHERE} works in /tmp/other, not this project. Only this project's sessions count as evidence.`,
    isError: true,
  });
  expect(results.get("r2")).toEqual({
    text: `Session ${LEARN} is a learning session. Read work sessions.`,
    isError: true,
  });
});

test("read_artifact shows memory bullet by bullet, skills exactly as they are, and says what it can't show", async () => {
  const memory = "# Notes\n- Use `bun test packages/host` for the host tests. <!-- strive:#12 -->\n- Use bun.\n";

  const items: MemoryItem[] = [
    { kind: "line", text: "# Notes" },
    { kind: "bullet", text: "Use `bun test packages/host` for the host tests.", source: 12, outsideReview: false },
    { kind: "bullet", text: "Use bun.", outsideReview: false },
  ];

  const release = "---\nname: release\ndescription: Cut a release.\n---\n1. `bun run build`\n2. Tag it.\n";

  const { model } = await learn({
    config: {
      instructions: [
        { path: `${CWD}/AGENTS.md`, text: "Use bun." },
        // As sessions load it: under a label that isn't part of the file.
        { path: `${CWD}/.strive/memory.md`, text: `Reviewed memory: ...\n\n${memory}` },
      ],
      skills: [
        { name: "release", description: "Cut a release.", path: `${CWD}/.strive/skills/release/SKILL.md` },
        { name: "huge", description: "Too big to send.", path: `${CWD}/.strive/skills/huge/SKILL.md` },
        { name: "global", description: "Everywhere.", path: "/home/u/.strive/skills/global/SKILL.md" },
      ],
      learnedFiles: [
        { artifact: { kind: "memory" }, text: memory, items },
        { artifact: { kind: "skill", name: "release" }, text: release },
      ],
    },
    script: [
      {
        toolCalls: [
          { id: "a1", name: "read_artifact", input: { artifact: { kind: "memory" } } },
          { id: "a2", name: "read_artifact", input: { artifact: { kind: "skill", name: "release" } } },
          { id: "a3", name: "read_artifact", input: { artifact: { kind: "skill", name: "deploy" } } },
          { id: "a4", name: "read_artifact", input: { artifact: { kind: "skill", name: "global" } } },
          { id: "a5", name: "read_artifact", input: { artifact: { kind: "skill", name: "huge" } } },
        ],
      },
      { text: "done" },
    ],
  });

  const r = toolResults(model.requests[1]);
  expect(r.get("a1")?.text).toBe(
    [
      ".strive/memory.md as it is now, each bullet with its source (a proposal changes one bullet):",
      "",
      "# Notes",
      "- [#12] Use `bun test packages/host` for the host tests.",
      "- [hand-written] Use bun.",
    ].join("\n"),
  );
  expect(r.get("a2")?.text).toBe(
    `${CWD}/.strive/skills/release/SKILL.md exactly as it is now (a proposal replaces all of it):\n\n${release}`,
  );
  expect(r.get("a3")?.text).toBe(
    `There is no skill named deploy. A proposal for it creates ${CWD}/.strive/skills/deploy/SKILL.md.`,
  );
  expect(r.get("a4")?.text).toContain("outside this project's .strive/skills");
  expect(r.get("a5")?.text).toContain("its text didn't reach the learner");
  expect(r.get("a5")?.text).toContain("don't propose a change to this skill");
});

test("interrupting stops a learner turn", async () => {
  const model = new FakeAnthropic([{ text: "slow", delayMs: 8000 }]);
  // The interrupt is pushed once the model call is under way.
  const run = learnWithPush(model, (daemon) => daemon.push("session/interrupt", { sessionId: LEARN }));
  const { recorded, answeredAtEnd } = await run;
  expect(recorded.at(-1)).toEqual({ type: "turnEnded", turn: 1, reason: { kind: "interrupted" } });
  expect(answeredAtEnd).toBe(0);
});

test("a learner turn stops at its time limit", async () => {
  const { recorded } = await learn({ config: { turnSeconds: 1 }, script: [{ text: "slow", delayMs: 8000 }] });
  expect(recorded.at(-1)).toEqual({ type: "turnEnded", turn: 1, reason: { kind: "timedOut", seconds: 1 } });
});

/** Runs one learner turn on a slow model, calling `act` once the model has been asked. */
async function learnWithPush(model: FakeAnthropic, act: (d: FakeDaemon) => void) {
  model.start();
  const recorded: Event[] = [];
  let seq = 2;

  const daemon = new FakeDaemon({
    "host/register": () => ({ result: config(model.url) }),
    "host/context": () => ({ result: context(config(model.url)) }),
    "session/attach": () => ({ result: { session: learningInfo, entries: [started, request(2, T0)] } }),
    "host/record": (p) => {
      recorded.push(p.event);

      return { result: { seq: ++seq } };
    },
    "host/stream": () => ({ result: {} }),
  });

  let client: StriveClient | undefined;
  stops.push(() => {
    client?.close();
    daemon.close();
    model.stop();
  });
  await daemon.listen();

  ({ client } = await runHost(daemon.socket, LEARN));
  const deadline = Date.now() + 10_000;

  while (model.requests.length === 0 && Date.now() < deadline) await Bun.sleep(20);
  act(daemon);

  while (!recorded.some((e) => e.type === "turnEnded") && Date.now() < deadline) await Bun.sleep(20);

  // Whether the model had answered when the turn ended: an interrupt that
  // ends it has to cut the call off, not wait for its reply.
  return { recorded, answeredAtEnd: model.answered };
}

/** An assistant message as pi-ai records it, calling `calls` (or answering `text`). */
const message = (calls: { id: string; name: string }[], text = "") => ({
  role: "assistant",
  content: [
    ...(text ? [{ type: "text", text }] : []),
    ...calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })),
  ],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: calls.length > 0 ? "toolUse" : "stop",
  timestamp: 0,
});

test("a learner resumes after a restart: its history replays, a cut-off turn is closed, and a waiting request runs", async () => {
  const [first, second, third] = [T0 + 3600_000, T0 + 2 * 3600_000 - 60_000, T0 + 3 * 3600_000];

  const reads = [
    { id: "a1", name: "list_sessions" },
    { id: "a2", name: "read_session" },
  ];

  const propose = [{ id: "a3", name: "propose_change" }];

  const events: [number, Event][] = [
    [first, { type: "learnRequested", sessions: [] }],
    [first, { type: "turnStarted", turn: 1, throughSeq: 2 }],
    [first, { type: "assistantMessage", turn: 1, text: "", toolCalls: reads, message: message(reads) }],
    [first, { type: "assistantMessage", turn: 1, text: "", toolCalls: propose, message: message(propose) }],
    [first, { type: "proposalMade", callId: "a3", proposal: PROPOSAL }],
    [first, { type: "gateFinished", proposal: 0, gate: "static", verdict: "fail", detail: "memory is over 16 KiB" }],
    [
      first,
      { type: "assistantMessage", turn: 1, text: "It failed.", toolCalls: [], message: message([], "It failed.") },
    ],
    [first, { type: "turnEnded", turn: 1, reason: { kind: "done" } }],
    [second, { type: "learnRequested", sessions: [] }],
    [second, { type: "turnStarted", turn: 2, throughSeq: 10 }],
    [third, { type: "learnRequested", sessions: [W1] }],
  ];

  const numbered = events.map(([tsMs, event], i) => ({ seq: i + 2, tsMs, event }));
  const made = seqIn(numbered, (e) => e.type === "proposalMade");

  // The gate names the proposal by the seq the history gives it.
  const history = [
    started,
    ...numbered.map((x) => (x.event.type === "gateFinished" ? { ...x, event: { ...x.event, proposal: made } } : x)),
  ];

  const { model, recorded } = await learn(
    {
      history,
      script: [{ toolCalls: [{ id: "t1", name: "list_sessions", input: {} }] }, { text: "Nothing new is worth it." }],
    },
    2,
  );

  expect(recorded[0]).toEqual({
    type: "turnEnded",
    turn: 2,
    reason: { kind: "failed", error: "the agent host stopped during this turn" },
  });
  expect(recorded[1]).toEqual({
    type: "turnStarted",
    turn: 3,
    throughSeq: seqIn(history, (e) => e.type === "learnRequested" && e.sessions.length > 0),
  });

  const sent = model.requests[0].messages;
  const text = (m: { content: TextBlock[] | string }) => blockText(m.content);
  expect(sent.map((m: { role: string }) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "user",
  ]);
  expect(text(sent[0])).toContain("You haven't looked at this project before");
  const replayed = toolResults(model.requests[0]);
  expect(replayed.get("a1")).toEqual({
    text: "This list_sessions output isn't kept in the journal. Call list_sessions again if you still need it.",
    isError: false,
  });
  expect(replayed.get("a3")).toEqual({
    text: `Recorded as proposal ${made}, but it failed the daemon's static check, so it can't be accepted: memory is over 16 KiB\nPropose again with that fixed if the change is still worth making; otherwise leave it.`,
    isError: true,
  });
  // The cut-off turn's request is history; the waiting one is this turn's prompt.
  expect(text(sent.at(-2))).toContain(`active since ${when(first)}, when you last looked.`);
  expect(text(sent.at(-1))).toContain(`Study these work sessions: ${W1}.`);

  // Sessions active since the request before this one are marked new.
  const listed = toolResults(model.requests[1]).get("t1")?.text ?? "";
  expect(listed).toContain(`"new" marks those active since you last looked (${when(second)})`);
  expect(listed.split("\n").find((l) => l.includes(W1))).toEndWith("[new]");
  expect(listed.split("\n").find((l) => l.includes(W0))).not.toContain("[new]");
});

test("a turn that takes two waiting requests marks sessions new since the first one's cutoff", async () => {
  const [first, second, third] = [T0 + 3600_000, T0 + 3 * 3600_000, T0 + 4 * 3600_000];
  // W1 was last active between the first request and the second.

  const done: [number, Event][] = [
    [first, { type: "learnRequested", sessions: [] }],
    [first, { type: "turnStarted", turn: 1, throughSeq: 2 }],
    [first, { type: "turnEnded", turn: 1, reason: { kind: "done" } }],
    [second, { type: "learnRequested", sessions: [] }],
    [third, { type: "learnRequested", sessions: [] }],
  ];

  const history = [started, ...done.map(([tsMs, event], i) => ({ seq: i + 2, tsMs, event }))];

  const { model } = await learn({
    history,
    script: [{ toolCalls: [{ id: "t1", name: "list_sessions", input: {} }] }, { text: "done" }],
  });

  const listed = toolResults(model.requests[1]).get("t1")?.text ?? "";
  expect(listed).toContain(`since you last looked (${when(first)})`);
  expect(listed.split("\n").find((l) => l.includes(W1))).toEndWith("[new]");
});

test("the learner's system prompt states its rules, and gives the current memory, instructions and skills", () => {
  const prompt = learnerPrompt(
    config("http://x", {
      instructions: [
        { path: `${CWD}/AGENTS.md`, text: "Use bun, not npm." },
        { path: `${CWD}/.strive/memory.md`, text: "Reviewed memory: ...\n\n- A remembered bullet: because." },
      ],
      skills: [{ name: "release", description: "Cut a release.", path: `${CWD}/.strive/skills/release/SKILL.md` }],
      learnedFiles: [
        {
          artifact: { kind: "memory" },
          text: "- A remembered bullet: because. <!-- strive:#7 -->",
          items: [{ kind: "bullet", text: "A remembered bullet: because.", source: 7, outsideReview: false }],
        },
      ],
    }),
  );

  const section = (title: string) => {
    const start = prompt.indexOf(`\n# ${title}\n`);
    const end = prompt.indexOf("\n# ", start + 1);

    return start < 0 ? "" : prompt.slice(start, end < 0 ? undefined : end);
  };

  expect(section("Current memory (.strive/memory.md)")).toContain("- [#7] A remembered bullet: because.");
  // The file as it is, not the label sessions see it under: a proposal starts from this text.
  expect(section("Current memory (.strive/memory.md)")).not.toContain("Reviewed memory");
  expect(section("Project instructions")).toContain(`## ${CWD}/AGENTS.md\n\nUse bun, not npm.`);
  expect(section("Project instructions")).not.toContain("remembered bullet");
  expect(section("Skills")).toContain(`- release: Cut a release. (${CWD}/.strive/skills/release/SKILL.md)`);

  const rules = [
    [
      "What is worth learning",
      [
        "repeated friction",
        "a correction the user made",
        "failed and was later fixed",
        "the hard way",
        "procedure that recurs",
      ],
    ],
    ["What isn't", ["already say", "one-off", "generic advice", "wouldn't act on differently"]],
    ["How to work", [`at most ${MAX_PROPOSALS}`, "often none"]],
    ["What you can change", ["concise bullets", "its why", "hand-written", "name", "description", "steps"]],
    [
      "Proposals",
      [
        "changes one bullet",
        "One bullet per proposal",
        "Prefer changing an existing bullet over adding a near-duplicate",
        '"#42"',
        "replaces the whole SKILL.md",
        "entire new content",
        "evidence",
        "seqs",
        "falsifiable",
        "could check",
      ],
    ],
    ["Never", ["approvals", "sandbox", "strive's own settings"]],
    ["Ending the run", ["what you proposed", "proposed nothing, say so plainly and say why"]],
  ] as const;

  for (const [title, phrases] of rules) {
    for (const p of phrases) expect(section(title)).toContain(p);
  }
});

test("a project with no memory, instructions or skills says so", () => {
  const prompt = learnerPrompt(config("http://x", { instructions: [], skills: [] }));
  expect(prompt).toContain("# Current memory (.strive/memory.md)\n\nThere is none yet. A memory proposal creates it.");
  expect(prompt).toContain("# Project instructions\n\nThere are none.");
  expect(prompt).toContain("# Skills\n\nThere are none.");
});

test("propose_change's parameters are the protocol's Proposal", () => {
  // The same set of values both ways: the protocol spells a memory change as an intersection.
  expectTypeOf<Static<typeof ProposalParams>>().toExtend<Proposal>();
  expectTypeOf<Proposal>().toExtend<Static<typeof ProposalParams>>();
  expectTypeOf<Static<typeof ReadArtifactParams>["artifact"]>().toEqualTypeOf<Artifact>();

  const tool = { name: "propose_change", description: "", parameters: ProposalParams };

  type Args = Parameters<typeof validateToolArguments>[1]["arguments"];

  const check = (args: Args) => () =>
    validateToolArguments(tool, { type: "toolCall", id: "x", name: "propose_change", arguments: args });

  expect(check(PROPOSAL)()).toEqual(PROPOSAL);

  const valid: Record<string, string>[] = [
    { kind: "skill", name: "release", content: "x" },
    { kind: "memory", op: "add", text: "x", after: "#3" },
    { kind: "memory", op: "change", bullet: "#3", text: "x" },
    { kind: "memory", op: "remove", bullet: "Use bun." },
  ];

  for (const change of valid) expect(check({ ...PROPOSAL, change })).not.toThrow();

  const invalid: Record<string, string>[] = [
    { kind: "file", path: "x" },
    { kind: "skill", content: "x" },
    { kind: "memory", content: "the whole file" },
    { kind: "memory", op: "rewrite", text: "x" },
    { kind: "memory", op: "change", text: "x" },
    { kind: "memory", op: "remove" },
  ];

  for (const change of invalid) expect(check({ ...PROPOSAL, change })).toThrow();
  const { prediction: _, ...unpredicted } = PROPOSAL;
  expect(check(unpredicted)).toThrow();
  expect(check({ ...PROPOSAL, evidence: [{ session: W1, seqs: ["one"], note: "" }] })).toThrow();
});

test("the learner sees how each bullet fared beside it", () => {
  const items: MemoryItem[] = [
    { kind: "bullet", text: "Use bun.", source: 4, outsideReview: false },
    { kind: "bullet", text: "Lock with ./dev lock.", source: 7, outsideReview: false },
    { kind: "bullet", text: "Mine.", outsideReview: false },
  ];

  const usage: BulletUsage[] = [
    {
      bullet: 4,
      sessions: 9,
      cited: 3,
      clean: 2,
      trouble: 1,
      notes: [{ session: "S1", seq: 12, atMs: 12_000, what: "the user corrected it: no, use npm" }],
    },
    { bullet: 7, sessions: 9, cited: 0, clean: 0, trouble: 0, notes: [] },
  ];

  expect(memoryItems(items, usage)).toBe(
    [
      "- [#4] Use bun.",
      "  (given to 9 sessions, cited in 3 turns, trouble after 1, latest: the user corrected it: no, use npm (session S1 #12))",
      "- [#7] Lock with ./dev lock.",
      "  (given to 9 sessions, never cited)",
      "- [hand-written] Mine.",
    ].join("\n"),
  );
  expect(memoryItems(items)).toBe("- [#4] Use bun.\n- [#7] Lock with ./dev lock.\n- [hand-written] Mine.");
});
