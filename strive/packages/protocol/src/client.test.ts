import { afterAll, beforeAll, expect, test } from "bun:test";
import { startDaemon, type TestDaemon } from "@strive/testkit";
import { PROTOCOL_VERSION, ServerError, StriveClient } from "./index";

const info = { name: "protocol-test", version: "0" };
let daemon: TestDaemon;

beforeAll(() => {
  daemon = startDaemon();
});
afterAll(() => daemon.dispose());

test("handshake reports the daemon's home and pid", async () => {
  const { client, init } = await StriveClient.connect(daemon.socket, info);
  expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(init.home).toBe(daemon.home);
  expect(init.server.pid).toBe(daemon.pid());
  client.close();
});

test("concurrent requests on one connection each get their own response", async () => {
  const { client, init } = await StriveClient.connect(daemon.socket, info);
  const [a, b] = await Promise.all([client.request("daemon/status", {}), client.request("daemon/status", {})]);
  expect(a.server.pid).toBe(init.server.pid);
  expect(b.clients).toBe(1);
  client.close();
});

test("server errors carry the JSON-RPC code", async () => {
  const { client } = await StriveClient.connect(daemon.socket, info);
  const err = await client.request("initialize", { protocolVersion: 999, client: info }).catch((e) => e);
  expect((err as ServerError).code).toBe(-32003);
  expect((err as ServerError).message).toBe("initialize: client speaks protocol 999, daemon speaks 1 (-32003)");
  expect((err as ServerError).detail).toBe("client speaks protocol 999, daemon speaks 1");
  client.close();
});

test("pending requests reject when the daemon goes away", async () => {
  const { client } = await StriveClient.connect(daemon.socket, info);
  const closed = new Promise<void>((r) => client.onClose(() => r()));
  await client.request("daemon/shutdown", {});
  await closed;
  await expect(client.request("daemon/status", {})).rejects.toThrow("daemon/status: connection closed");
});
