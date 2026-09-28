/**
 * Smoke evals against the real control plane + OpenCode.
 * Grow this list; each task is one verifiable agent outcome.
 */
import { startControlPlane } from "../src/server/control-plane.js";
import { readFile, access } from "node:fs/promises";
import path from "node:path";

type Task = {
  readonly name: string;
  readonly prompt: string;
  readonly expectFile: string;
  readonly assert?: (content: string) => void;
};

const tasks: Task[] = [
  {
    name: "math-add",
    prompt:
      "Create src/math.ts exporting function add(a: number, b: number): number that returns a+b. Do not modify other files.",
    expectFile: "src/math.ts",
    assert: (c) => {
      if (!c.includes("add")) throw new Error("missing add");
    },
  },
  {
    name: "greet-txt",
    prompt: "Create notes/hello.txt containing exactly the text hello-eval",
    expectFile: "notes/hello.txt",
    assert: (c) => {
      if (!c.includes("hello-eval")) throw new Error(`unexpected: ${c}`);
    },
  },
];

async function waitIdle(base: string, id: string, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await fetch(`${base}/api/sessions/${id}`);
    const j = (await r.json()) as { status: string; lastError?: string };
    if (j.status === "idle") return;
    if (j.status === "error") throw new Error(j.lastError ?? "error");
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("timeout");
}

async function main() {
  const port = 8799;
  const base = `http://127.0.0.1:${port}`;
  const cp = await startControlPlane({
    port,
    host: "127.0.0.1",
    rootDir: path.join("/tmp", "hatch-inspect-eval"),
    modelId: process.env.OPENCODE_MODEL ?? "big-pickle",
  });

  const results: { name: string; ok: boolean; detail: string }[] = [];
  try {
    for (const task of tasks) {
      try {
        const create = await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: task.name, prompt: task.prompt }),
        });
        const session = (await create.json()) as { id: string; repoDir: string };
        await waitIdle(base, session.id);
        const file = path.join(session.repoDir, task.expectFile);
        await access(file);
        const content = await readFile(file, "utf8");
        task.assert?.(content);
        await fetch(`${base}/api/sessions/${session.id}`, { method: "DELETE" });
        results.push({ name: task.name, ok: true, detail: "pass" });
        console.log("PASS", task.name);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        results.push({ name: task.name, ok: false, detail });
        console.error("FAIL", task.name, detail);
      }
    }
  } finally {
    await cp.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
