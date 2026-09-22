// Cross-language test: the TS client against the real Rust daemon binary.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROTOCOL_VERSION, ServerError, StriveClient } from "./index";

const exe = resolve(import.meta.dir, "../../../target/debug/strive");
const home = mkdtempSync("/tmp/strv-ts-");
const env = { ...process.env, STRIVE_HOME: home };
const socket = join(home, "run/strived.sock");
const info = { name: "protocol-test", version: "0" };

beforeAll(() => {
  const r = Bun.spawnSync([exe, "status", "--json"], { env });
  if (r.exitCode !== 0) throw new Error(`daemon did not start: ${r.stderr}`);
});
afterAll(() => {
  Bun.spawnSync([exe, "stop"], { env });
  rmSync(home, { recursive: true, force: true });
});

test("handshake and typed requests", async () => {
  const { client, init } = await StriveClient.connect(socket, info);
  expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
  expect(init.home).toBe(home);
  const [a, b] = await Promise.all([client.request("daemon/status", {}), client.request("daemon/status", {})]);
  expect(a.server.pid).toBe(init.server.pid);
  expect(b.clients).toBeGreaterThanOrEqual(1);
  client.close();
});

test("server errors carry codes", async () => {
  const { client } = await StriveClient.connect(socket, info);
  const err = await client.request("initialize", { protocolVersion: 999, client: info }).catch((e) => e);
  expect(err).toBeInstanceOf(ServerError);
  expect((err as ServerError).code).toBe(-32003);
  client.close();
});

test("pending requests reject when the daemon goes away", async () => {
  const { client } = await StriveClient.connect(socket, info);
  const closed = new Promise<void>((r) => client.onClose(() => r()));
  await client.request("daemon/shutdown", {});
  await closed;
  await expect(client.request("daemon/status", {})).rejects.toThrow("connection closed");
});
