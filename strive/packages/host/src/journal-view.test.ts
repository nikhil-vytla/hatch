// read_session's rendering of a work session's journal: what the learner
// sees of it, how pages split it, and how long outputs are cut.
import { expect, test } from "bun:test";
import type { Entry, Event, SessionReadResult } from "@strive/protocol";
import { cut, renderSession, tokens } from "./journal-view";

const CWD = "/tmp/proj";

const T0 = Date.UTC(2026, 8, 20, 14, 3);

/** A failing test run's output: noise first, the error at the end. */
const TEST_OUTPUT = `${"ok   packages/tui/src/view.test.ts\n".repeat(300)}error: Cannot find module "@strive/testkit" from packages/host/src/host.test.ts\n1 fail`;

const blobs = new Map([
  ["sha256:test", TEST_OUTPUT],
  ["sha256:old", 'import { x } from "../testkit";'],
  ["sha256:new", 'import { x } from "@strive/testkit";'],
  ["sha256:edited", "edited packages/host/src/host.test.ts"],
]);

const blob = async (digest: string) => {
  const text = blobs.get(digest);

  if (text === undefined) throw new Error(`no blob ${digest}`);

  return text;
};

const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" });

/** A realistic work session: a failed test run, a declined command, a correction, an edit, a rewind, a failed turn. */
const events: Event[] = [
  { type: "sessionStarted", format: 1, cwd: CWD, striveVersion: "0.3.0" },
  { type: "budgetSet", usdMicros: 5_000_000 },
  { type: "userMessage", text: "fix the host tests" },
  {
    type: "contextLoaded",
    instructions: [{ path: `${CWD}/AGENTS.md`, digest: "sha256:agents", bytes: 10 }],
    skills: ["release"],
    mcp: [{ server: "db", tools: 0, error: "exited with status 1" }],
  },
  { type: "turnStarted", turn: 1, throughSeq: 3 },
  {
    type: "modelCallStarted",
    call: 1,
    provider: "anthropic",
    model: "m",
    request: "sha256:req",
    reservedUsdMicros: 1,
    reservedTokens: 1,
  },
  {
    type: "modelCallFinished",
    call: 1,
    outcome: {
      kind: "complete",
      status: 200,
      usage: { input: 1, output: 1, cacheWrite: 0, cacheWriteLong: 0, cacheRead: 0 },
      costUsdMicros: 1,
    },
    durationMs: 5,
  },
  {
    type: "assistantMessage",
    turn: 1,
    text: "",
    toolCalls: [
      { id: "c1", name: "bash" },
      { id: "c2", name: "bash" },
    ],
    message: reply(""),
  },
  { type: "effectStarted", effect: 1, callId: "c1", record: { kind: "bash", command: "bun test", timeoutMs: 120000 } },
  {
    type: "effectFinished",
    effect: 1,
    outcome: { kind: "done", output: "sha256:test", exitCode: 1, truncated: false },
    durationMs: 900,
  },
  {
    type: "effectStarted",
    effect: 2,
    callId: "c2",
    record: { kind: "bash", command: "rm -rf node_modules", timeoutMs: 0 },
  },
  { type: "approvalRequested", effect: 2, description: "run: rm -rf node_modules" },
  { type: "approvalDecided", effect: 2, decision: "deny", by: "tui" },
  {
    type: "effectFinished",
    effect: 2,
    outcome: { kind: "refused", reason: "declined: run: rm -rf node_modules" },
    durationMs: 3000,
  },
  { type: "turnEnded", turn: 1, reason: { kind: "interrupted" } },
  { type: "userMessage", text: "no, don't delete node_modules. The import path is wrong." },
  { type: "turnStarted", turn: 2, throughSeq: 16 },
  {
    type: "assistantMessage",
    turn: 2,
    text: "The test imports testkit by a relative path.",
    toolCalls: [{ id: "c3", name: "edit" }],
    message: reply("The test imports testkit by a relative path."),
  },
  {
    type: "effectStarted",
    effect: 3,
    callId: "c3",
    record: {
      kind: "edit",
      path: "packages/host/src/host.test.ts",
      oldText: "sha256:old",
      newText: "sha256:new",
    },
  },
  {
    type: "effectFinished",
    effect: 3,
    outcome: { kind: "done", output: "sha256:edited", truncated: false },
    durationMs: 2,
  },
  { type: "rewound", to: 1, savedAs: 2 },
  { type: "modelCallFinished", call: 2, outcome: { kind: "rejected", status: 529 }, durationMs: 40 },
  { type: "turnEnded", turn: 2, reason: { kind: "failed", error: "overloaded" } },
];

const entries: Entry[] = events.map((event, i) => ({ seq: i + 1, tsMs: T0 + i * 1000, event }));

const session: SessionReadResult = {
  session: { id: "01WORK", cwd: CWD, createdAtMs: T0, title: "fix the host tests", lastActiveMs: T0 + 60_000 },
  entries,
  committed: entries.length,
  tornBytes: 0,
};

const seqOf = (pred: (e: Event) => boolean) => entries.find((x) => pred(x.event))?.seq ?? -1;

test("a journal reads as its prompts, replies, commands with their outcomes, approvals and failures, by seq", async () => {
  const page = await renderSession(session, blob, { budgetTokens: 100_000 });
  const cmd = seqOf((e) => e.type === "effectStarted" && e.effect === 1);
  const lines = page.split("\n");

  expect(lines.slice(0, 2)).toEqual([
    `Session 01WORK "fix the host tests" in ${CWD}`,
    "Started 2026-09-20 14:03 UTC, last active 2026-09-20 14:04 UTC.",
  ]);
  // The command's line, then its output indented, cut in the middle with the error at the end kept.
  const at = lines.indexOf(`#${cmd} ran \`bun test\``);
  expect(lines.slice(at, at + 3)).toEqual([
    `#${cmd} ran \`bun test\``,
    `#${cmd + 1} result of #${cmd}: exit 1`,
    "  ok   packages/tui/src/view.test.ts",
  ]);
  expect(page).toContain('error: Cannot find module "@strive/testkit" from packages/host/src/host.test.ts\n  1 fail');
  expect(page).toMatch(/\[\.\.\. \d+ characters cut \.\.\.\]/);

  const tail = page.slice(page.indexOf("  1 fail") + "  1 fail\n".length);
  expect(tail.split("\n")).toEqual([
    "#11 ran `rm -rf node_modules`",
    "#12 asked for approval: run: rm -rf node_modules",
    "#13 declined by tui",
    "#14 result of #11: refused: declined: run: rm -rf node_modules",
    "#15 turn 1 interrupted by the user",
    "#16 user: no, don't delete node_modules. The import path is wrong.",
    "#17 turn 2",
    "#18 agent: The test imports testkit by a relative path.",
    "#19 edited packages/host/src/host.test.ts",
    '  - import { x } from "../testkit";',
    '  + import { x } from "@strive/testkit";',
    "#20 result of #19: done",
    "  edited packages/host/src/host.test.ts",
    "#21 rewound the files to checkpoint 1 (the files before it saved as checkpoint 2)",
    "#22 the model call was rejected (HTTP 529)",
    "#23 turn 2 failed: overloaded",
    "",
    "[End of the journal, at #23.]",
  ]);

  const head = page.slice(0, page.indexOf(`#${cmd} `));
  expect(head.split("\n").slice(3)).toEqual([
    "#3 user: fix the host tests",
    `#4 loaded ${CWD}/AGENTS.md; skills: release; MCP servers that failed: db (exited with status 1)`,
    "#5 turn 1",
    "",
  ]);
  // Bookkeeping a reader learns nothing from isn't shown.
  expect(page).not.toContain("#1 ");
  expect(page).not.toContain("#2 ");
  expect(page).not.toContain("#6 ");
  expect(page).not.toContain("#7 ");
});

test("pages stay within the budget, and together show every entry once", async () => {
  const budget = 400;
  const full = await renderSession(session, blob, { budgetTokens: 100_000 });
  const blockSeqs = (page: string) => [...page.matchAll(/^#(\d+) /gm)].map((m) => Number(m[1]));
  const pages: string[] = [];
  let from: number | undefined = 1;

  while (from !== undefined && pages.length < 50) {
    const page = await renderSession(session, blob, { fromSeq: from, budgetTokens: budget });
    pages.push(page);
    const more = page.match(/Call read_session with fromSeq (\d+)/);
    from = more ? Number(more[1]) : undefined;
  }

  expect(pages.length).toBeGreaterThan(2);

  for (const page of pages) expect(tokens(page)).toBeLessThanOrEqual(budget);
  expect(pages.flatMap(blockSeqs)).toEqual(blockSeqs(full));
  expect(pages.at(-1)).toEndWith("[End of the journal, at #23.]");
});

test("a command with no end in the journal says so", async () => {
  const cmd = seqOf((e) => e.type === "effectStarted" && e.effect === 1);
  const cutShort = { ...session, entries: entries.filter((x) => x.seq <= cmd) };
  const page = await renderSession(cutShort, blob, { fromSeq: cmd, budgetTokens: 100_000 });
  expect(page).toContain(`#${cmd} ran \`bun test\` (no result: the session ended or is still running)`);
});

test("a reply's tool calls that ran no effect are named", async () => {
  const withCall: SessionReadResult = {
    ...session,
    entries: [
      ...entries,
      {
        seq: 24,
        tsMs: T0,
        event: {
          type: "assistantMessage",
          turn: 3,
          text: "Checking.",
          toolCalls: [{ id: "gone", name: "read" }],
          message: reply(""),
        },
      },
    ],
  };

  const page = await renderSession(withCall, blob, { fromSeq: 24, budgetTokens: 100_000 });
  expect(page).toContain("#24 agent: Checking. [called read, with no effect run]");
});

test("a journal that fails verification says so", async () => {
  const bad = { ...session, problem: "entry 24's MAC doesn't match" };
  const page = await renderSession(bad, blob, { budgetTokens: 100_000 });
  expect(page.split("\n")[2]).toBe(
    "Its journal fails verification (entry 24's MAC doesn't match); only the entries before that are shown.",
  );
});

test("cutting keeps the start and the end, and says how much went", () => {
  const text = `${"a".repeat(500)}${"z".repeat(500)}`;
  const out = cut(text, 100);
  expect(out).toBe(`${"a".repeat(40)}\n[... 900 characters cut ...]\n${"z".repeat(60)}`);
  expect(cut("short", 100)).toBe("short");
});
