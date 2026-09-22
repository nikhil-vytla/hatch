#!/usr/bin/env bun
// Entry point. `strive` starts the daemon and execs this with STRIVE_SOCKET set.
import { ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { StriveClient } from "@strive/protocol";
import { App } from "./app";

const socket = process.env.STRIVE_SOCKET;
if (!socket) {
  console.error("strive-tui is started by `strive`; run `strive` instead.");
  process.exit(2);
}

let connected;
try {
  connected = await StriveClient.connect(socket, { name: "strive-tui", version: process.env.STRIVE_VERSION ?? "dev" });
} catch (e) {
  console.error(`strive: could not reach the daemon at ${socket}: ${(e as Error).message}\nRun \`strive doctor\`.`);
  process.exit(1);
}

const tui = new TuiMainScreen(new ProcessTerminal());
const exit = (code: number) => {
  tui.stop();
  connected.client.close();
  process.exit(code);
};
new App(tui, connected.client, connected.init, exit);
tui.start();
