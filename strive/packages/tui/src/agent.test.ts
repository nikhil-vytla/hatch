// The TUI with a real agent: daemon, host and gateway, with a scripted model.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { type Event, StriveClient } from "@strive/protocol";
import {
  type DaemonSettings,
  FakeAnthropic,
  type ScriptedReply,
  startDaemon,
  type TestDaemon,
  VirtualTerminal,
} from "@strive/testkit";
import { App, type SessionMode } from "./app";

setDefaultTimeout(30_000);

const HOST = `bun ${resolve(import.meta.dir, "../../host/src/main.ts")}`;

let daemon: TestDaemon | undefined;

let fake: FakeAnthropic | undefined;

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  daemon?.dispose();
  fake?.stop();
});

async function open(script: ScriptedReply[], settings?: DaemonSettings) {
  fake = new FakeAnthropic(script).start();
  daemon = startDaemon(
    { STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test", STRIVE_HOST: HOST },
    settings,
  );
  const cwd = realpathSync(mkdtempSync("/tmp/strv-tui-agent-"));
  const ui = await attach(cwd, "new");

  return { ...ui, cwd };
}

/** A TUI on a session in `cwd`, against the test's daemon. */
async function attach(cwd: string, mode: SessionMode) {
  if (!daemon) throw new Error("no daemon");
  const term = new VirtualTerminal(100, 40);
  const tui = new TuiMainScreen(term);
  const exits: number[] = [];
  const { client, init } = await StriveClient.connect(daemon.socket, { name: "tui", version: "0" });

  // As main.ts does: the screen stops as the app exits, so what it shows then is what the person is left with.
  const exit = (code: number) => {
    tui.stop();
    exits.push(code);
  };

  const app = new App(tui, client, init, exit, cwd);
  tui.start();
  await app.open(mode);
  const before = stop;
  stop = () => (before?.(), tui.stop(), client.close());

  const type = async (text: string) => {
    term.type(text);
    await Bun.sleep(20);
    term.type("\r");
  };

  return { term, type, exits, client };
}

/** Waits until the app has exited. */
async function exited(exits: number[]) {
  for (let i = 0; exits.length === 0; i++) {
    if (i > 500) throw new Error("the app never exited");
    await Bun.sleep(10);
  }
}

/** The events of the project's learning session, on a connection of the test's own: none if it has none. */
async function learningEvents(cwd: string): Promise<Event[]> {
  if (!daemon) throw new Error("no daemon");
  const { client } = await StriveClient.connect(daemon.socket, { name: "test", version: "0" });

  try {
    const { sessions } = await client.request("session/list", { cwd, kind: "learning" });
    const id = sessions[0]?.id;

    if (id === undefined) return [];

    return (await client.request("session/read", { id })).entries.map((e) => e.event);
  } finally {
    client.close();
  }
}

/** A session in which the second prompt corrects the first turn. */
async function corrected(settings?: DaemonSettings) {
  const ui = await open([{ text: "Ran npm test." }, { text: "Ran bun test." }], settings);
  await ui.type("run the tests");
  await ui.term.waitFor("Ran npm test.", 15_000);
  await ui.type("no, use bun test");
  await ui.term.waitFor("Ran bun test.", 15_000);
  const { sessions } = await ui.client.request("session/list", { cwd: ui.cwd });
  const id = sessions[0]?.id;

  if (id === undefined) throw new Error("no session");

  return { ...ui, id };
}

// The first offer in a daemon where no learner has run: priced as a typical run.
const OFFER = "This session had a correction. Learn from it? It costs a learner run, about $0.21. [y/N]";

test("quitting a session with a correction offers to learn from it, and y asks for a run naming it", async () => {
  const { term, exits, cwd, id } = await corrected();
  term.type("\x04");
  await term.waitFor(OFFER);
  expect(exits).toEqual([]);
  term.type("y");
  await exited(exits);
  expect(exits).toEqual([0]);
  const left = (await term.screen()).join("\n");
  expect(left).toContain("Asked the learner to study this session; `strive review` will show what it proposes.");
  expect(left).not.toContain("[y/N]");
  const asked = (await learningEvents(cwd)).filter((e) => e.type === "learnRequested");
  expect(asked.map((e) => e.type === "learnRequested" && [e.sessions, e.offer])).toEqual([[[id], true]]);
});

test("anything but y exits without a run, and the session isn't offered again", async () => {
  const { term, exits, cwd, id } = await corrected();
  term.type("\x04");
  await term.waitFor(OFFER);
  term.type("n");
  await exited(exits);
  expect(exits).toEqual([0]);
  const events = await learningEvents(cwd);
  expect(events.filter((e) => e.type === "learnRequested")).toEqual([]);
  expect(
    events.filter((e) => e.type === "learnDismissed").map((e) => e.type === "learnDismissed" && e.session),
  ).toEqual([id]);

  // Back in the same session later, quitting just exits.
  const again = await attach(cwd, { resume: id });
  again.term.type("\x04");
  await exited(again.exits);
  expect((await again.term.screen()).some((l) => l.includes("Learn from it?"))).toBe(false);
});

test("a clean session exits with no offer", async () => {
  const { term, type, exits } = await open([{ text: "Added the flag." }]);
  await type("add a --verbose flag");
  await term.waitFor("Added the flag.", 15_000);
  await type("/quit");
  await exited(exits);
  expect(exits).toEqual([0]);
  expect((await term.screen()).some((l) => l.includes("Learn from it?"))).toBe(false);
});

test("no offer when learning.ask is false", async () => {
  const { term, exits, cwd } = await corrected({ learning: { ask: false } });
  term.type("\x04");
  await exited(exits);
  expect((await term.screen()).some((l) => l.includes("Learn from it?"))).toBe(false);
  expect(await learningEvents(cwd)).toEqual([]);
});

test("the agent's reply and its file changes show in the transcript", async () => {
  const { term, cwd, type } = await open([
    { toolCalls: [{ id: "toolu_1", name: "write", input: { path: "hello.txt", content: "hi" } }] },
    { text: "Wrote hello.txt with a greeting." },
  ]);

  await type("make hello.txt");
  const screen = await term.waitFor("Wrote hello.txt with a greeting.", 15_000);
  expect(screen.some((l) => l.includes("write hello.txt (2 bytes)"))).toBe(true);
  expect(
    screen.some((l) => l.includes("claude-sonnet-4-5 …")),
    "model calls show their cost, not a start line",
  ).toBe(false);
  expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("hi");
  await term.waitFor("$0.0");
  expect(screen.some((l) => l.includes("No agent is connected"))).toBe(false);
  await Bun.sleep(300);
  const footer = (await term.screen()).at(-1)!.trim();
  expect(footer).toMatch(/^\$0\.\d{4} of \$5\.0000$/);
});

test("the footer shows the agent working, and Esc interrupts it", async () => {
  const { term, type } = await open([{ text: "slow", delayMs: 10_000 }]);
  await type("take your time");
  await term.waitFor("working… Esc to interrupt", 15_000);
  term.type("\x1b");
  await term.waitFor("Interrupted.", 5000);
  const screen = await term.screen();
  expect(screen.some((l) => l.includes("working…"))).toBe(false);
});
