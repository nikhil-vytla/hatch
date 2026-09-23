import { afterEach, expect, test } from "bun:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { StriveClient } from "@strive/protocol";
import { FakeDaemon, VirtualTerminal } from "@strive/testkit";
import { App } from "./app";

const ID = "01J8ZSESSIONAAAAAAAAAAAAAA";
const session = { id: ID, cwd: "/tmp/r", createdAtMs: 0 };
const started = { seq: 1, tsMs: 0, event: { type: "sessionStarted", format: 1, cwd: "/tmp/r", striveVersion: "x" } };
const message = (seq: number, text: string) => ({ seq, tsMs: 0, event: { type: "userMessage", text } });

let fake: FakeDaemon | undefined;
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  fake?.close();
});

async function open(handlers: ConstructorParameters<typeof FakeDaemon>[0]) {
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
