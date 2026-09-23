// The TUI with a real agent: daemon, host and gateway, with a scripted model.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { StriveClient } from "@strive/protocol";
import { FakeAnthropic, type ScriptedReply, startDaemon, type TestDaemon, VirtualTerminal } from "@strive/testkit";
import { App } from "./app";

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

async function open(script: ScriptedReply[]) {
  fake = new FakeAnthropic(script).start();
  daemon = startDaemon({ STRIVE_UPSTREAM_ANTHROPIC: fake.url, ANTHROPIC_API_KEY: "sk-test", STRIVE_HOST: HOST });
  const cwd = realpathSync(mkdtempSync("/tmp/strv-tui-agent-"));
  const term = new VirtualTerminal(100, 40);
  const tui = new TuiMainScreen(term);
  const { client, init } = await StriveClient.connect(daemon.socket, { name: "tui", version: "0" });
  const app = new App(tui, client, init, () => {}, cwd);
  tui.start();
  await app.open("new");
  stop = () => (tui.stop(), client.close());
  const type = async (text: string) => {
    term.type(text);
    await Bun.sleep(20);
    term.type("\r");
  };
  return { term, cwd, type };
}

test("the agent's reply and its file changes show in the transcript", async () => {
  const { term, cwd, type } = await open([
    { toolCalls: [{ id: "toolu_1", name: "write", input: { path: "hello.txt", content: "hi" } }] },
    { text: "Wrote hello.txt with a greeting." },
  ]);
  await type("make hello.txt");
  const screen = await term.waitFor("Wrote hello.txt with a greeting.", 15_000);
  expect(screen.some((l) => l.includes("write hello.txt (2 bytes)"))).toBe(true);
  expect(readFileSync(join(cwd, "hello.txt"), "utf8")).toBe("hi");
  await term.waitFor("$0.0");
  expect(screen.some((l) => l.includes("No agent is connected"))).toBe(false);
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
