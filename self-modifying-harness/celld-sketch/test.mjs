// End-to-end test for the Forge sketch on celld 0.6.2. Plain Node 22 ESM, no dependencies.
// It starts `celld dev` on a free port, runs the scenarios with fetch, and exits non-zero on failure.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const projectDir = dirname(fileURLToPath(import.meta.url));

const COUNTER_V1 = 'const n = (kv.get("n") ?? 0) + (args.by ?? 1); kv.put("n", n); return n;';
const COUNTER_V2 = 'const n = (kv.get("n") ?? 0) + 10; kv.put("n", n); return n;';
const COUNTER_BAD = 'const n = (kv.get("n") ?? 0) + 100; kv.put("n", n); return n;';

let port = 0;
let base = "";
let proc = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: chosen } = server.address();
      server.close(() => resolve(chosen));
    });
  });
}

function spawnCelld(clean) {
  const args = ["dev", "--no-watch", "--port", String(port)];
  if (clean) args.push("--clean");
  args.push(".");
  const child = spawn("celld", args, { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] });
  child.celldLog = "";
  const collect = (chunk) => {
    child.celldLog += chunk.toString();
    if (child.celldLog.length > 20000) child.celldLog = child.celldLog.slice(-20000);
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  return child;
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("exit", (code) => resolve(code));
  });
}

async function waitUntilReady(child, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`celld exited early with code ${child.exitCode}:\n${child.celldLog.slice(-3000)}`);
    }
    try {
      // Any HTTP answer, including the sketch's 404, means the listener is up.
      await fetch(`${base}/`, { signal: AbortSignal.timeout(2000) });
      return;
    } catch {
      // Not listening yet.
    }
    await sleep(250);
  }
  throw new Error(`celld did not answer within ${timeoutMs}ms:\n${child.celldLog.slice(-3000)}`);
}

async function start(clean) {
  proc = spawnCelld(clean);
  await waitUntilReady(proc);
}

async function stop() {
  if (proc === null) return;
  const child = proc;
  proc = null;
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = waitForExit(child);
  const timedOut = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
  if (timedOut) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

async function post(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

const results = [];
async function scenario(id, title, fn) {
  let pass = false;
  let detail = "";
  try {
    const out = await fn();
    pass = out.pass === true;
    detail = out.detail;
  } catch (error) {
    detail = `threw: ${error && error.message ? error.message : String(error)}`;
  }
  results.push({ id, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${id}. ${title}`);
  console.log(`     ${detail}`);
}

async function main() {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  console.log(`celld test on ${base}\n`);

  await start(true);
  try {
    await scenario("a", "propose counter with passing checks -> ok:true", async () => {
      const r = await post("/propose", {
        name: "counter",
        version: "counter-v1",
        source: COUNTER_V1,
        checks: [{ args: {}, expect: 1 }, { args: { by: 2 }, expect: 3 }],
      });
      return { pass: r.json && r.json.ok === true, detail: `POST /propose -> HTTP ${r.status} ${r.text}` };
    });

    await scenario("b", "two calls with different callIds -> 1 then 2", async () => {
      const r1 = await post("/call", { name: "counter", args: {}, callId: "b1" });
      const r2 = await post("/call", { name: "counter", args: {}, callId: "b2" });
      return {
        pass: r1.json === 1 && r2.json === 2,
        detail: `call b1 -> ${r1.text}, call b2 -> ${r2.text}`,
      };
    });

    await scenario("c", "repeat the second call with the same callId -> 2, no increment", async () => {
      const r = await post("/call", { name: "counter", args: {}, callId: "b2" });
      return { pass: r.json === 2, detail: `repeat b2 -> ${r.text}` };
    });

    await scenario("d", "failing checks -> ok:false and the live version is unchanged (next call 3)", async () => {
      const bad = await post("/propose", {
        name: "counter",
        version: "counter-bad",
        source: COUNTER_BAD,
        checks: [{ args: {}, expect: 9999 }],
      });
      const next = await post("/call", { name: "counter", args: {}, callId: "d1" });
      return {
        pass: bad.json && bad.json.ok === false && next.json === 3,
        detail: `POST /propose -> HTTP ${bad.status} ${bad.text}, next call -> ${next.text}`,
      };
    });

    await scenario("e", "v2 takes effect while the facet is warm and keeps state (3 -> 13)", async () => {
      const v2 = await post("/propose", {
        name: "counter",
        version: "counter-v2",
        source: COUNTER_V2,
        checks: [{ args: {}, expect: 10 }],
      });
      const next = await post("/call", { name: "counter", args: {}, callId: "e1" });
      return {
        pass: v2.json && v2.json.ok === true && next.json === 13,
        detail: `POST /propose -> HTTP ${v2.status} ${v2.text}, next call -> ${next.text} (expected 13)`,
      };
    });

    await scenario("f", "restart without --clean -> state persisted (13 -> 23)", async () => {
      await stop();
      await sleep(500);
      await start(false);
      const next = await post("/call", { name: "counter", args: {}, callId: "f1" });
      return { pass: next.json === 23, detail: `after restart, call -> ${next.text} (expected 23)` };
    });

    await scenario("g", "checks run on scratch state: first real call starts at 0, not at 3", async () => {
      const proposed = await post("/propose", {
        name: "scratch-isolation",
        version: "scratch-v1",
        source: COUNTER_V1,
        checks: [{ args: {}, expect: 1 }, { args: {}, expect: 2 }, { args: {}, expect: 3 }],
      });
      const first = await post("/call", { name: "scratch-isolation", args: {}, callId: "g1" });
      return {
        pass: proposed.json && proposed.json.ok === true && first.json === 1,
        detail: `POST /propose -> HTTP ${proposed.status} ${proposed.text} (checks ended at 3), first real call -> ${first.text} (expected 1)`,
      };
    });
  } finally {
    await stop();
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((r) => r.id).join(", ")}`);
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stop().finally(() => process.exit(1));
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
