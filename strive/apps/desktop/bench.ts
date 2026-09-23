// Streams reply text into a long session and reports the renderer's frame
// times. Run from apps/desktop after `cargo build` and `bun run build.ts`:
// node bench.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { _electron as electron } from "playwright";

declare global {
  interface Window {
    benchFrames: number[];
  }
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const STRIVE = "../../target/debug/strive";

const home = mkdtempSync("/tmp/strv-bench-");

const cwd = mkdtempSync("/tmp/strv-bench-ws-");

const env = { ...process.env, STRIVE_HOME: home, STRIVE_HOST: "none" };

const pause = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

execFileSync(STRIVE, ["status"], { env });

const socket = connect(`${home}/run/strived.sock`);

await new Promise((ok) => socket.once("connect", ok));

let next = 0;

const send = (method: string, params: { [key: string]: Json }) =>
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: ++next, method, params })}\n`);

send("initialize", { protocolVersion: 1, client: { name: "bench", version: "0" } });

send("session/create", { cwd });

await pause(300);

const sessions: { id: string }[] = JSON.parse(
  execFileSync(STRIVE, ["sessions", "--all", "--json"], { env }).toString(),
);

const id = sessions[0]?.id ?? "";

send("host/register", { id }); // only the host may stream reply text

// Each prompt adds a checkpoint line too: about a thousand lines in all.
for (let i = 0; i < 500; i++) send("session/prompt", { id, text: `prompt ${i}` });

const app = await electron.launch({
  executablePath: createRequire(import.meta.url)("electron"),
  args: [".", "--resume", id, "--cwd", cwd],
  env: { ...process.env, STRIVE_SOCKET: `${home}/run/strived.sock` },
});

const page = await app.firstWindow();

await page.getByText("prompt 499").first().waitFor({ timeout: 90_000 });

await page.evaluate(() => {
  const frames: number[] = [];
  window.benchFrames = frames;
  let last = performance.now();

  const tick = (t: number) => {
    frames.push(t - last);
    last = t;
    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
});

let text = "";

const started = Date.now();

while (Date.now() - started < 5000) {
  text += "word ";
  send("host/stream", { id, turn: 1, text });
  await pause(8);
}

const frames = await page.evaluate(() => window.benchFrames.slice(5));

frames.sort((a, b) => a - b);

const at = (p: number) => (frames[Math.floor(frames.length * p)] ?? 0).toFixed(1);

console.log(`5s of reply text at ~120 deltas/s: ${frames.length} frames, p50 ${at(0.5)} ms, p95 ${at(0.95)} ms`);

await app.close();

socket.end();

execFileSync(STRIVE, ["stop"], { env });
