import { expect, test } from "bun:test";
import type { Entry, Event } from "@strive/protocol";
import { budgetText, describe } from "./describe";

const entry = (event: Event): Entry => ({ seq: 1, tsMs: 0, event });

test("prompts and replies are marked so each client can render them its own way", () => {
  expect(describe(entry({ type: "userMessage", text: "fix it" }))).toEqual([
    { kind: "prompt", tone: "plain", text: "fix it" },
  ]);
  expect(describe(entry({ type: "assistantMessage", turn: 1, text: "  Done.\n", toolCalls: [], message: {} }))).toEqual(
    [{ kind: "reply", tone: "plain", text: "Done." }],
  );
});

test("a turn that failed on a provider's error body says its message, not the JSON", () => {
  const failed = (error: string) =>
    describe(entry({ type: "turnEnded", turn: 1, reason: { kind: "failed", error } }))[0]?.text;

  const body = JSON.stringify({
    error: { message: "strive: no anthropic API key; run `strive auth anthropic`", type: "authentication_error" },
    type: "error",
  });

  expect(failed(`401 ${body}`)).toBe(
    "The agent stopped: No anthropic API key; run `strive auth anthropic` (HTTP 401).",
  );
  expect(failed("socket hang up")).toBe("The agent stopped: socket hang up");
  expect(failed("500 {not json")).toBe("The agent stopped: 500 {not json");
  expect(failed('400 {"detail":"x"}')).toBe('The agent stopped: 400 {"detail":"x"}');
});

test("a reply with no text (only tool calls) adds no line", () => {
  const e: Event = {
    type: "assistantMessage",
    turn: 1,
    text: " ",
    toolCalls: [{ id: "t", name: "read" }],
    message: {},
  };

  expect(describe(entry(e))).toEqual([]);
});

test("paths under the home directory are shown with ~, others as they are", () => {
  const started = (cwd: string) => entry({ type: "sessionStarted", format: 1, cwd, striveVersion: "x" });
  expect(describe(started("/Users/me/repo"), { home: "/Users/me" })[0]?.text).toBe("Session started in ~/repo");
  expect(describe(started("/srv/repo"), { home: "/Users/me" })[0]?.text).toBe("Session started in /srv/repo");
});

test("only MCP servers that failed to start get a line, one each", () => {
  const e: Event = {
    type: "contextLoaded",
    instructions: [],
    skills: [],
    mcp: [
      { server: "ok", tools: 3 },
      { server: "a", tools: 0, error: "can't run a" },
      { server: "b", tools: 0, error: "it exited during initialize" },
    ],
  };

  expect(describe(entry(e))).toEqual([
    { kind: "note", tone: "danger", text: "MCP server a didn't start: can't run a" },
    { kind: "note", tone: "danger", text: "MCP server b didn't start: it exited during initialize" },
  ]);
});

test("a failed command shows its exit code; a successful one adds nothing", () => {
  const finished = (exitCode?: number): Event => ({
    type: "effectFinished",
    effect: 1,
    outcome: { kind: "done", output: "sha256:00", exitCode, truncated: false },
    durationMs: 1,
  });

  expect(describe(entry(finished(0)))).toEqual([]);
  expect(describe(entry(finished(undefined)))).toEqual([]);
  expect(describe(entry(finished(2)))).toEqual([{ kind: "note", tone: "faint", text: "exit 2" }]);
});

test("automatic learning says what triggered a run, why one was skipped, and when the gate accepted", () => {
  const trigger = {
    kind: "idle" as const,
    signals: [
      { session: "S1", seq: 4, kind: "correction" as const, detail: "no, use bun" },
      { session: "S1", seq: 9, kind: "interrupted" as const, detail: "turn 2 was interrupted" },
      { session: "S1", seq: 12, kind: "correction" as const, detail: "i said bun" },
    ],
  };

  const failed = {
    kind: "turns" as const,
    signals: [{ session: "S2", seq: 3, kind: "turnFailed" as const, detail: "turn 1 failed: overloaded" }],
  };

  const text = (e: Event) => describe(entry(e))[0]?.text;

  expect(text({ type: "learnRequested", sessions: ["S1"], trigger })).toBe(
    "Automatic learning run, after a session went idle: a correction and an interrupted turn in session S1",
  );
  expect(text({ type: "learnRequested", sessions: ["S1"] })).toBe("Asked to learn from S1");
  expect(text({ type: "learnSkipped", trigger: failed, reason: "the cap" })).toBe(
    "Automatic learning run skipped (after a session's turns reached learning.everyTurns: a failed turn in session S2): the cap",
  );
  expect(text({ type: "proposalDecided", proposal: 7, decision: "accept", by: "gate", automatic: "gate" })).toBe(
    "#7 accepted automatically: every check passed",
  );
  // Only the daemon's field makes it automatic, not a client's name.
  expect(text({ type: "proposalDecided", proposal: 7, decision: "accept", by: "gate" })).toBe(
    "#7 accepted by gate (a client)",
  );
});

test("budgets read as dollars, tokens, both, or unlimited", () => {
  expect(budgetText(5_000_000)).toBe("$5.0000");
  expect(budgetText(undefined, 1000)).toBe("1000 tokens");
  expect(budgetText(1, 10)).toBe("$0.0001 and 10 tokens");
  expect(budgetText()).toBe("unlimited");
});
