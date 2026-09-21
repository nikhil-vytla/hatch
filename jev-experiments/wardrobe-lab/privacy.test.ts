import { expect, test } from "bun:test";
import { wardrobeToken } from "../experience-prototypes/server/wardrobe-token";
import { connectWardrobe } from "../experience-prototypes/server/wardrobe-stream";
import { FAL_MODEL } from "./engine";
test("token only accepts supplied key and fixed model", async () => {
  let calls = 0;
  const mock = async (url: any, init: any) => {
    calls++;
    expect(url).toBe("https://rest.fal.ai/tokens/realtime");
    expect(init.headers.Authorization).toBe("Key visitor-key");
    expect(JSON.parse(init.body)).toEqual({
      app: FAL_MODEL,
      token_expiration: 70,
    });
    return Response.json("scoped-token");
  };
  await expect(
    wardrobeToken("", { model: FAL_MODEL }, mock as any),
  ).rejects.toThrow();
  await expect(
    wardrobeToken("visitor-key", { model: "other" }, mock as any),
  ).rejects.toThrow();
  await expect(
    wardrobeToken("visitor-key", { model: FAL_MODEL }, mock as any),
  ).resolves.toEqual({
    token: "scoped-token",
    model: FAL_MODEL,
    expiresIn: 70,
  });
  expect(calls).toBe(1);
});
test("close during authorization prevents opening socket and stops source", async () => {
  let release!: (s: string) => void,
    stops = 0,
    sockets = 0;
  const stream = { getTracks: () => [{ stop: () => stops++ }] } as any;
  const session = connectWardrobe({
    input: stream,
    initial: { prompt: "outfit", revision: 0 },
    token: () => new Promise((r) => (release = r)),
    createSocket: () => {
      sockets++;
      return {} as any;
    },
  });
  session.close();
  release("short-lived");
  await Bun.sleep(5);
  expect(stops).toBe(1);
  expect(sockets).toBe(0);
  await expect(session.ready).rejects.toThrow("ended");
});
test("close CONNECTING socket, clears handlers and source", async () => {
  let closed = 0,
    stops = 0;
  const socket: any = { readyState: 0, close: () => closed++ };
  const session = connectWardrobe({
    input: { getTracks: () => [{ stop: () => stops++ }] } as any,
    initial: { prompt: "outfit", revision: 0 },
    token: async () => "short-lived",
    createSocket: () => socket,
  });
  await Bun.sleep(5);
  session.close();
  session.close();
  expect(closed).toBe(1);
  expect(stops).toBe(1);
  expect(socket.onmessage).toBe(null);
});
test("automatic session cap stops media", async () => {
  let stops = 0;
  const session = connectWardrobe({
    input: { getTracks: () => [{ stop: () => stops++ }] } as any,
    initial: { prompt: "outfit", revision: 0 },
    token: () => new Promise(() => {}),
    maxSeconds: 0.01,
  });
  await Bun.sleep(20);
  expect(stops).toBe(1);
  await expect(session.ready).rejects.toThrow();
});
test("older wardrobe revision cannot overwrite newer video prompt", async () => {
  const sent: Uint8Array[] = [];
  const socket: any = {
    readyState: 1,
    send: (data: Uint8Array) => sent.push(data),
    close: () => {},
  };
  const session = connectWardrobe({
    input: { getTracks: () => [] } as any,
    initial: { prompt: "initial", revision: 1 },
    token: async () => "short-lived",
    createSocket: () => socket,
  });
  await Bun.sleep(5);
  socket.onopen();
  session.update({ prompt: "latest", revision: 3 });
  session.update({ prompt: "stale", revision: 2 });
  const { decode } =
    await import("../experience-prototypes/node_modules/@msgpack/msgpack");
  expect(sent.map((bytes) => (decode(bytes) as any).prompt)).toEqual([
    "initial",
    "latest",
  ]);
  session.close();
});
