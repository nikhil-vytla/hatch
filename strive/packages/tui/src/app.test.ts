import { afterEach, beforeEach, expect, test } from "bun:test";
import { TuiMainScreen } from "@earendil-works/pi-tui";
import { StriveClient } from "@strive/protocol";
import { startDaemon, type TestDaemon, VirtualTerminal } from "@strive/testkit";
import { App } from "./app";

let daemon: TestDaemon;
let term: VirtualTerminal;
let tui: TuiMainScreen;
let exits: number[];
let client: StriveClient;

beforeEach(async () => {
  daemon = startDaemon();
  term = new VirtualTerminal(100, 30);
  tui = new TuiMainScreen(term);
  const codes: number[] = [];
  exits = codes;
  const connected = await StriveClient.connect(daemon.socket, { name: "tui-test", version: "0" });
  client = connected.client;
  new App(tui, client, connected.init, (code) => codes.push(code), "/tmp/some-repo");
  tui.start();
});

afterEach(() => {
  tui.stop();
  client.close();
  daemon.dispose();
});

const daemonClients = () => JSON.parse(daemon.strive("status", "--json").stdout).clients as number;

const enter = async (text: string) => {
  term.type(text);
  await Bun.sleep(20);
  term.type("\x1b");
  term.type("\r");
};

test("the header names the working directory", async () => {
  const screen = await term.waitFor("strive");
  expect(screen[0]).toContain("/tmp/some-repo");
});

test("/status reports the daemon the TUI is attached to", async () => {
  await enter("/status");
  const screen = await term.waitFor("daemon pid");
  const line = screen.find((l) => l.includes("daemon pid"));
  expect(line).toContain(`daemon pid ${daemon.pid()} ·`);
  expect(line).toContain("· 1 client");
});

test("a prompt is echoed and the missing agent is stated", async () => {
  await enter("fix the flaky test");
  const screen = await term.waitFor("› fix the flaky test");
  expect(screen.some((l) => l.includes("Nothing can run this yet"))).toBe(true);
});

test("an unknown command is named in the error", async () => {
  await enter("/nope");
  await term.waitFor("Unknown command /nope. Type /help.");
});

test("Ctrl+C exits with status 0 and is not reported as a lost connection", async () => {
  term.type("\x03");
  await Bun.sleep(50);
  expect(exits).toEqual([0]);
  expect(daemonClients()).toBe(1);
  expect((await term.screen()).some((l) => l.includes("Lost the connection"))).toBe(false);
});

test("/quit exits with status 0 and disconnects", async () => {
  await enter("/quit");
  await Bun.sleep(50);
  expect(exits).toEqual([0]);
  expect(daemonClients()).toBe(1);
});

test("losing the daemon is reported and exits with status 1", async () => {
  daemon.strive("stop");
  await term.waitFor("Lost the connection to the daemon.");
  expect(exits).toEqual([1]);
});
