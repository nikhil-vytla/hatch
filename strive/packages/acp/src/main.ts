// `strive acp` execs `strive-tui acp`, which runs this with STRIVE_SOCKET
// set: ACP on stdio, the daemon on its socket.
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { describeError, StriveClient } from "@strive/protocol";
import { bridge } from "./bridge";

const socket = process.env.STRIVE_SOCKET;

if (!socket) {
  console.error("strive's ACP bridge is started by `strive acp`; run that instead.");
  process.exit(2);
}

const version = process.env.STRIVE_VERSION ?? "dev";

let daemon: StriveClient;

try {
  daemon = (await StriveClient.connect(socket, { name: "strive-acp", version })).client;
} catch (e) {
  console.error(`strive: could not reach the daemon at ${socket}: ${describeError(e)}\nRun \`strive doctor\`.`);
  process.exit(1);
}

daemon.onClose(() => process.exit(1));

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

const connection = bridge(daemon, version).connect(stream);

await connection.closed;

daemon.close();

process.exit(0);
