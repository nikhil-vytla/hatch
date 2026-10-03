import { afterEach, expect, test } from "bun:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { type Entry, type SessionInfo, StriveClient } from "@strive/protocol";
import { FakeDaemon, type FakeHandlers, VirtualTerminal } from "@strive/testkit";
import { App } from "./app";

const ID = "01J8ZSESSIONAAAAAAAAAAAAAA";

const session: SessionInfo = { id: ID, cwd: "/tmp/r", createdAtMs: 0 };

const started: Entry = {
  seq: 1,
  tsMs: 0,
  event: { type: "sessionStarted", format: 1, cwd: "/tmp/r", striveVersion: "x" },
};

const message = (seq: number, text: string): Entry => ({ seq, tsMs: 0, event: { type: "userMessage", text } });

let fake: FakeDaemon | undefined;

let stop: (() => void) | undefined;

afterEach(() => {
  stop?.();
  fake?.close();
});

async function open(handlers: FakeHandlers) {
  fake = new FakeDaemon(handlers);
  await fake.listen();
  const term = new VirtualTerminal(100, 30);
  const tui = new TuiMainScreen(term);
  const { client, init } = await StriveClient.connect(fake.socket, { name: "t", version: "0" });
  const app = new App(tui, client, init, () => {}, "/tmp/r");
  tui.start();
  stop = () => (tui.stop(), client.close());
  await app.open({ resume: ID });

  return { term, app };
}

test("an entry that arrives before the attach reply is still shown, once, in order", async () => {
  const { term } = await open({
    "session/attach": (_p, notify) => {
      notify("session/entry", { sessionId: ID, entry: message(2, "arrived early") });
      notify("session/entry", { sessionId: ID, entry: message(1 + 0, "duplicate of history") });

      return { result: { session, entries: [started] } };
    },
  });

  const screen = await term.waitFor("› arrived early");
  const started_ = screen.findIndex((l) => l.includes("Session started"));
  const early = screen.findIndex((l) => l.includes("› arrived early"));
  expect(started_).toBeGreaterThanOrEqual(0);
  expect(early).toBe(started_ + 1);
  expect(screen.some((l) => l.includes("duplicate of history"))).toBe(false);
});

test("entries for another session are not shown", async () => {
  const { term } = await open({
    "session/attach": (_p, notify) => {
      notify("session/entry", { sessionId: "01J8ZOTHERSESSIONBBBBBBBBB", entry: message(2, "someone else's") });

      return { result: { session, entries: [started, message(2, "mine")] } };
    },
  });

  const screen = await term.waitFor("› mine");
  expect(screen.some((l) => l.includes("someone else's"))).toBe(false);
});

test("a prompt the daemon fails to save is kept in the editor and the error is shown", async () => {
  const { term, app } = await open({
    "session/attach": () => ({ result: { session, entries: [started] } }),
    "session/prompt": () => ({ error: { code: -32603, message: "No space left on device (os error 28)" } }),
  });

  await term.waitFor("Session started");
  term.type("my important prompt");
  await Bun.sleep(20);
  term.type("\r");
  await term.waitFor("Couldn't confirm your message was saved: No space left on device (os error 28)");
  expect(app.editor.getText()).toBe("my important prompt");
});

test("a prompt sent again after its saving wasn't confirmed keeps its request id", async () => {
  const ids: (string | undefined)[] = [];

  const { term, app } = await open({
    "session/attach": () => ({ result: { session, entries: [started] } }),
    "session/prompt": (p) => {
      ids.push(p.requestId);

      return ids.length === 1
        ? { error: { code: -32603, message: "the connection dropped" } }
        : { result: { seq: ids.length + 1 } };
    },
  });

  await term.waitFor("Session started");
  term.type("ship it");
  await Bun.sleep(20);
  term.type("\r");
  await term.waitFor("Couldn't confirm your message was saved");
  // Sent again as it was, from the editor it was kept in.
  term.type("\r");

  while (ids.length < 2) await Bun.sleep(10);
  term.type("something else");
  await Bun.sleep(20);
  term.type("\r");

  while (ids.length < 3) await Bun.sleep(10);

  expect(ids[0]).toBeString();
  expect(ids[1]).toBe(ids[0]!);
  expect(ids[2]).not.toBe(ids[0]!);
  expect(app.editor.getText()).toBe("");
});
