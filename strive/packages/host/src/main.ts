#!/usr/bin/env bun
// `strive-tui host --session ID`: the daemon starts this for a session.
import { StriveClient } from "@strive/protocol";
import { Host } from "./host";

export async function runHost(socket: string, sessionId: string): Promise<{ host: Host; client: StriveClient }> {
  const { client } = await StriveClient.connect(socket, {
    name: "strive-host",
    version: process.env.STRIVE_VERSION ?? "dev",
  });
  const config = await client.request("host/register", { id: sessionId });
  const host = new Host(client, sessionId, config);
  client.on("session/entry", ({ sessionId: sid, entry }) => sid === sessionId && host.onEntry(entry));
  client.on("session/interrupt", ({ sessionId: sid }) => sid === sessionId && host.interrupt());
  const { entries } = await client.request("session/attach", { id: sessionId });
  await host.start(entries);
  return { host, client };
}

if (import.meta.main || process.argv[2] === "host") {
  const i = process.argv.indexOf("--session");
  const sessionId = i >= 0 ? process.argv[i + 1] : undefined;
  const socket = process.env.STRIVE_SOCKET;
  if (!sessionId || !socket) {
    console.error("usage: strive-tui host --session ID (with STRIVE_SOCKET set); the daemon starts this");
    process.exit(2);
  }
  const { client } = await runHost(socket, sessionId);
  client.onClose(() => process.exit(0));
}
